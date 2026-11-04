import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/index.js";
import { closeDb, getDb, runMigrations } from "@tea-ledger/database";
import { issueFarmDeviceAccess } from "../apps/api/src/device-auth.js";
import { hashSupervisorPassword } from "../apps/api/src/supervisor-auth.js";

const farmA = "00000000-0000-4000-a000-0000000000a1";
const farmB = "00000000-0000-4000-a000-0000000000a2";
const adminId = "00000000-0000-4000-a000-0000000000a3";
const supervisorId = "00000000-0000-4000-a000-0000000000a4";
const deviceId = "00000000-0000-4000-a000-0000000000a5";
const secondDeviceId = "00000000-0000-4000-a000-0000000000a6";
const adminUsername = "lockdown-admin";
const adminPassword = "Lockdown Admin Password 2026";
const supervisorUsername = "lockdown-supervisor";
const supervisorPassword = "Lockdown Supervisor Password 2026";
let app: FastifyInstance;

function legacyPasswordHash(value: string, salt = "lockdown-test-salt"): string {
  return `${salt}:${createHash("sha256").update(salt + value).digest("hex")}`;
}

async function supervisorToken(): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/supervisor/login",
    payload: { farm_id: farmA, username: supervisorUsername, password: supervisorPassword },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { token: string }).token;
}

beforeAll(async () => {
  process.env.USE_PGLITE = "true";
  process.env.SESSION_SECRET = "device-lockdown-test-secret-that-is-long-enough";
  process.env.ADMIN_USERNAME = adminUsername;
  process.env.ADMIN_DEFAULT_PASSWORD = adminPassword;
  const db = await getDb();
  await runMigrations(db);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2),($3,$4)", [
    farmA,
    "Lockdown Farm A",
    farmB,
    "Lockdown Farm B",
  ]);
  await db.query(
    "INSERT INTO users (user_id, farm_id, role, username, password_hash) VALUES ($1,$2,'admin',$3,$4)",
    [adminId, farmA, adminUsername, legacyPasswordHash(adminPassword)],
  );
  await db.query(
    "INSERT INTO users (user_id, farm_id, role, username, password_hash) VALUES ($1,$2,'supervisor',$3,$4)",
    [
      supervisorId,
      farmA,
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
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_DEFAULT_PASSWORD;
});

describe("field-device lockdown", () => {
  it("requires a farm-bound Supervisor enrollment, stores only a digest, rejects cross-farm use, and honors revocation", async () => {
    const anonymousEnrollment = await app.inject({
      method: "POST",
      url: `/api/farms/${farmA}/devices/enroll`,
      payload: { device_id: deviceId },
    });
    expect(anonymousEnrollment.statusCode).toBe(401);

    const supervisor = await supervisorToken();
    const enrollment = await app.inject({
      method: "POST",
      url: `/api/farms/${farmA}/devices/enroll`,
      headers: { authorization: `Bearer ${supervisor}` },
      payload: { device_id: deviceId },
    });
    expect(enrollment.statusCode).toBe(200);
    const { device_token: token } = enrollment.json() as { device_token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{30,}$/);

    const headers = { "x-tea-device-id": deviceId, "x-tea-device-token": token };
    const allowed = await app.inject({
      method: "GET",
      url: `/api/farms/${farmA}/workers`,
      headers,
    });
    expect(allowed.statusCode).toBe(200);

    const crossFarmRead = await app.inject({
      method: "GET",
      url: `/api/farms/${farmB}/workers`,
      headers,
    });
    expect(crossFarmRead.statusCode).toBe(401);

    const crossFarmEnroll = await app.inject({
      method: "POST",
      url: `/api/farms/${farmB}/devices/enroll`,
      headers: { authorization: `Bearer ${supervisor}` },
      payload: { device_id: secondDeviceId },
    });
    expect(crossFarmEnroll.statusCode).toBe(403);

    await expect(issueFarmDeviceAccess({ farmId: farmB, deviceId })).rejects.toThrow(
      /already enrolled to a different farm/,
    );

    const db = await getDb();
    const stored = await db.query(
      "SELECT farm_id, access_token_hash, revoked FROM devices WHERE device_id=$1",
      [deviceId],
    );
    const row = stored.rows[0] as {
      farm_id: string;
      access_token_hash: string;
      revoked: boolean;
    };
    expect(row.farm_id).toBe(farmA);
    expect(row.access_token_hash).toMatch(/^device:[a-f0-9]{64}$/);
    expect(row.access_token_hash).not.toBe(token);
    expect(row.revoked).toBe(false);

    await db.query("UPDATE devices SET revoked=true WHERE device_id=$1", [deviceId]);
    const revoked = await app.inject({
      method: "GET",
      url: `/api/farms/${farmA}/workers`,
      headers,
    });
    expect(revoked.statusCode).toBe(401);
  });
});

describe("Admin session lockdown", () => {
  it("upgrades a legacy password, stores a digest-only session, and rejects prior raw session rows", async () => {
    const anonymousReport = await app.inject({
      method: "GET",
      url: `/api/farms/${farmA}/reports/monthly`,
    });
    expect(anonymousReport.statusCode).toBe(401);
    const anonymousPayroll = await app.inject({
      method: "GET",
      url: `/api/farms/${farmA}/payroll/2026-11-02`,
    });
    expect(anonymousPayroll.statusCode).toBe(401);
    const anonymousSmsLog = await app.inject({
      method: "GET",
      url: `/api/sms-log?farm_id=${farmA}`,
    });
    expect(anonymousSmsLog.statusCode).toBe(401);
    const removedLegacyEmployment = await app.inject({
      method: "GET",
      url: "/api/workers/00000000-0000-4000-a000-0000000000af/employment",
    });
    expect(removedLegacyEmployment.statusCode).toBe(404);

    const login = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { username: adminUsername, password: adminPassword },
    });
    expect(login.statusCode).toBe(200);
    const { token } = login.json() as { token: string };

    const db = await getDb();
    const user = await db.query("SELECT password_hash FROM users WHERE user_id=$1", [adminId]);
    expect((user.rows[0] as { password_hash: string }).password_hash).toMatch(/^scrypt-v1\$/);
    const session = await db.query(
      "SELECT token FROM sessions WHERE user_id=$1 AND role='admin' ORDER BY created_at DESC LIMIT 1",
      [adminId],
    );
    const storedToken = (session.rows[0] as { token: string }).token;
    expect(storedToken).toMatch(/^admin:[a-f0-9]{64}$/);
    expect(storedToken).not.toBe(token);

    const authenticated = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authenticated.statusCode).toBe(200);

    const ownReport = await app.inject({
      method: "GET",
      url: `/api/farms/${farmA}/reports/monthly`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ownReport.statusCode).toBe(200);
    const foreignReport = await app.inject({
      method: "GET",
      url: `/api/farms/${farmB}/reports/monthly`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(foreignReport.statusCode).toBe(403);

    const legacyRawToken = "former-raw-admin-session-token";
    await db.query(
      "INSERT INTO sessions (token, user_id, farm_id, role, expires_at) VALUES ($1,$2,$3,'admin',$4)",
      [legacyRawToken, adminId, farmA, new Date(Date.now() + 60_000).toISOString()],
    );
    const stale = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      headers: { authorization: `Bearer ${legacyRawToken}` },
    });
    expect(stale.statusCode).toBe(401);
  });
});
