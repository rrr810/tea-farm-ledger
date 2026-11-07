import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/index.js";
import { closeDb, getDb, runMigrations } from "@tea-ledger/database";
import { issueFarmDeviceAccess } from "../apps/api/src/device-auth.js";
import { hashSupervisorPassword } from "../apps/api/src/supervisor-auth.js";

const targetFarmId = "00000000-0000-4000-a000-000000000811";
const sourceFarmId = "00000000-0000-4000-a000-000000000812";
const adminId = "00000000-0000-4000-a000-000000000813";
const deviceId = "00000000-0000-4000-a000-000000000814";
const joinDeviceId = "00000000-0000-4000-a000-000000000815";
const supervisorId = "00000000-0000-4000-a000-000000000816";
const adminUsername = "field-link-owner";
const adminPassword = "Field Link Owner Password 2026";
const supervisorUsername = "joining-supervisor";
const supervisorPassword = "Joining Supervisor Password 2026";
let app: FastifyInstance;

function legacyPasswordHash(value: string, salt = "field-link-test-salt"): string {
  return `${salt}:${createHash("sha256").update(salt + value).digest("hex")}`;
}

beforeAll(async () => {
  process.env.USE_PGLITE = "true";
  process.env.SESSION_SECRET = "field-device-link-test-secret-that-is-long-enough";
  const db = await getDb();
  await runMigrations(db);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2),($3,$4)", [
    targetFarmId,
    "Target linking farm",
    sourceFarmId,
    "Source linking farm",
  ]);
  await db.query(
    "INSERT INTO users (user_id, farm_id, role, username, password_hash) VALUES ($1,$2,'admin',$3,$4)",
    [adminId, targetFarmId, adminUsername, legacyPasswordHash(adminPassword)],
  );
  await db.query(
    "INSERT INTO users (user_id, farm_id, role, username, password_hash) VALUES ($1,$2,'supervisor',$3,$4)",
    [
      supervisorId,
      targetFarmId,
      supervisorUsername,
      await hashSupervisorPassword(supervisorPassword),
    ],
  );
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb();
  delete process.env.SESSION_SECRET;
});

describe("Owner-approved field-device linking", () => {
  it("uses a one-time code to replace an empty browser's farm credential without moving data", async () => {
    const oldAccess = await issueFarmDeviceAccess({
      farmId: sourceFarmId,
      deviceId,
    });
    const ownerLogin = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { username: adminUsername, password: adminPassword },
    });
    expect(ownerLogin.statusCode).toBe(200);
    const ownerToken = (ownerLogin.json() as { token: string }).token;

    const createCode = await app.inject({
      method: "POST",
      url: `/api/admin/farms/${targetFarmId}/field-device-link-codes`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {},
    });
    expect(createCode.statusCode).toBe(201);
    const codeResult = createCode.json() as { code: string; expires_at: string };
    expect(codeResult.code).toMatch(/^TL-[A-Za-z0-9_-]{32}$/);
    expect(new Date(codeResult.expires_at).getTime()).toBeGreaterThan(Date.now());

    const db = await getDb();
    const persistedCode = await db.query(
      "SELECT code_hash FROM field_device_link_codes WHERE farm_id=$1",
      [targetFarmId],
    );
    const codeHash = (persistedCode.rows[0] as { code_hash: string }).code_hash;
    expect(codeHash).toMatch(/^field-device-link:[a-f0-9]{64}$/);
    expect(codeHash).not.toContain(codeResult.code);

    const link = await app.inject({
      method: "POST",
      url: "/api/field-devices/link",
      payload: { code: codeResult.code, device_id: deviceId },
    });
    expect(link.statusCode).toBe(200);
    const linked = link.json() as {
      ok: boolean;
      farm_id: string;
      name: string;
      device_token: string;
    };
    expect(linked).toEqual(expect.objectContaining({
      ok: true,
      farm_id: targetFarmId,
      name: "Target linking farm",
    }));
    expect(linked.device_token).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const staleSourceAccess = await app.inject({
      method: "GET",
      url: `/api/farms/${sourceFarmId}`,
      headers: {
        "x-tea-device-id": deviceId,
        "x-tea-device-token": oldAccess.deviceToken,
      },
    });
    expect(staleSourceAccess.statusCode).toBe(401);

    const targetAccess = await app.inject({
      method: "GET",
      url: `/api/farms/${targetFarmId}`,
      headers: {
        "x-tea-device-id": deviceId,
        "x-tea-device-token": linked.device_token,
      },
    });
    expect(targetAccess.statusCode).toBe(200);
    expect(targetAccess.json()).toEqual({ farm_id: targetFarmId, name: "Target linking farm" });

    const reused = await app.inject({
      method: "POST",
      url: "/api/field-devices/link",
      payload: { code: codeResult.code, device_id: deviceId },
    });
    const random = await app.inject({
      method: "POST",
      url: "/api/field-devices/link",
      payload: { code: "TL-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", device_id: deviceId },
    });
    expect(reused.statusCode).toBe(400);
    expect(random.statusCode).toBe(400);
    expect(reused.json()).toEqual(random.json());
    expect(reused.json()).toEqual({ error: "link code is invalid, expired, or already used" });

    const device = await db.query(
      "SELECT farm_id, supervisor_user_id FROM devices WHERE device_id=$1",
      [deviceId],
    );
    expect(device.rows[0]).toEqual({ farm_id: targetFarmId, supervisor_user_id: null });
    const audit = await db.query(
      "SELECT farm_id, action, detail FROM audit_log WHERE target=$1 ORDER BY id ASC",
      [deviceId],
    );
    expect((audit.rows as Array<{ action: string }>).map((row) => row.action)).toEqual([
      "field_device.unlinked",
      "field_device.linked",
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(codeResult.code);
  });

  it("lets a Supervisor join the uniquely named existing farm and proves possession of an old device credential before rebinding", async () => {
    const oldAccess = await issueFarmDeviceAccess({
      farmId: sourceFarmId,
      deviceId: joinDeviceId,
    });
    const join = await app.inject({
      method: "POST",
      url: "/api/field-devices/join-existing-farm",
      payload: {
        farm_name: "target LINKING FARM",
        username: supervisorUsername.toUpperCase(),
        password: supervisorPassword,
        device_id: joinDeviceId,
        current_device_token: oldAccess.deviceToken,
      },
    });
    expect(join.statusCode).toBe(200);
    const joined = join.json() as {
      ok: boolean;
      farm_id: string;
      name: string;
      device_token: string;
      username: string;
      supervisor_token: string;
      supervisor_expires_at: string;
    };
    expect(joined).toEqual(expect.objectContaining({
      ok: true,
      farm_id: targetFarmId,
      name: "Target linking farm",
      username: supervisorUsername,
    }));
    expect(joined.device_token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(joined.supervisor_token).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const supervisorSession = await app.inject({
      method: "GET",
      url: "/api/supervisor/me",
      headers: { authorization: `Bearer ${joined.supervisor_token}` },
    });
    expect(supervisorSession.statusCode).toBe(200);
    expect(supervisorSession.json()).toEqual(expect.objectContaining({
      farm_id: targetFarmId,
      username: supervisorUsername,
      role: "supervisor",
    }));

    const staleSourceAccess = await app.inject({
      method: "GET",
      url: `/api/farms/${sourceFarmId}`,
      headers: {
        "x-tea-device-id": joinDeviceId,
        "x-tea-device-token": oldAccess.deviceToken,
      },
    });
    expect(staleSourceAccess.statusCode).toBe(401);

    const wrongDeviceProof = await app.inject({
      method: "POST",
      url: "/api/field-devices/join-existing-farm",
      payload: {
        farm_name: "Target linking farm",
        username: supervisorUsername,
        password: supervisorPassword,
        device_id: joinDeviceId,
        current_device_token: "not-the-old-opaque-device-token",
      },
    });
    expect(wrongDeviceProof.statusCode).toBe(401);
    expect(wrongDeviceProof.json()).toEqual({
      error: "farm name or supervisor credentials are invalid",
    });

    const ambiguousOrMissing = await app.inject({
      method: "POST",
      url: "/api/field-devices/join-existing-farm",
      payload: {
        farm_name: "A farm that does not exist",
        username: supervisorUsername,
        password: supervisorPassword,
        device_id: crypto.randomUUID(),
      },
    });
    expect(ambiguousOrMissing.statusCode).toBe(401);
    expect(ambiguousOrMissing.json()).toEqual({
      error: "farm name or supervisor credentials are invalid",
    });
  });
});
