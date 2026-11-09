import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/index.js";
import { closeDb, getDb, runMigrations } from "@tea-ledger/database";

let app: FastifyInstance;
let farmId = "";
const ownerPassword = "New Owner Password 2026";
const supervisorPassword = "New Supervisor Password 2026";

beforeAll(async () => {
  process.env.USE_PGLITE = "true";
  const db = await getDb();
  await runMigrations(db);
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe("Owner-led new-farm registration", () => {
  it("creates an isolated farm, Owner, first Supervisor, default rate, and digest-only Owner session together", async () => {
    const registration = await app.inject({
      method: "POST",
      url: "/api/admin/register-farm",
      payload: {
        farm_name: "  Green Hills Tea Farm  ",
        owner_username: "GreenHills.Owner",
        owner_password: ownerPassword,
        supervisor_username: "GreenHills.Supervisor",
        supervisor_password: supervisorPassword,
      },
    });

    expect(registration.statusCode).toBe(201);
    const result = registration.json() as {
      ok: boolean;
      farm_id: string;
      name: string;
      role: string;
      owner_username: string;
      supervisor_username: string;
      token: string;
      expires_at: string;
      initial_rate_cents_per_kg: number;
    };
    farmId = result.farm_id;
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      name: "Green Hills Tea Farm",
      role: "admin",
      owner_username: "greenhills.owner",
      supervisor_username: "greenhills.supervisor",
      initial_rate_cents_per_kg: 900,
    }));
    expect(result.farm_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(result)).not.toContain(ownerPassword);
    expect(JSON.stringify(result)).not.toContain(supervisorPassword);

    const db = await getDb();
    const farm = await db.query("SELECT name FROM farms WHERE farm_id=$1", [farmId]);
    expect(farm.rows).toEqual([{ name: "Green Hills Tea Farm" }]);
    const rates = await db.query(
      "SELECT effective_from, rate_cents_per_kg FROM rates WHERE farm_id=$1",
      [farmId],
    );
    expect(rates.rows).toHaveLength(1);
    expect(rates.rows[0]).toEqual(expect.objectContaining({ rate_cents_per_kg: 900 }));

    const accounts = await db.query(
      "SELECT role, username, password_hash FROM users WHERE farm_id=$1 ORDER BY role ASC",
      [farmId],
    );
    expect(accounts.rows).toHaveLength(2);
    expect(accounts.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "admin", username: "greenhills.owner", password_hash: expect.stringMatching(/^scrypt-v1\$/) }),
      expect.objectContaining({ role: "supervisor", username: "greenhills.supervisor", password_hash: expect.stringMatching(/^scrypt-v1\$/) }),
    ]));
    expect(JSON.stringify(accounts.rows)).not.toContain(ownerPassword);
    expect(JSON.stringify(accounts.rows)).not.toContain(supervisorPassword);

    const storedSession = await db.query(
      "SELECT token FROM sessions WHERE farm_id=$1 AND role='admin'",
      [farmId],
    );
    expect(storedSession.rows).toHaveLength(1);
    expect((storedSession.rows[0] as { token: string }).token).toMatch(/^admin:[a-f0-9]{64}$/);
    expect((storedSession.rows[0] as { token: string }).token).not.toBe(result.token);

    const audit = await db.query(
      "SELECT actor, action, detail FROM audit_log WHERE farm_id=$1 ORDER BY id ASC",
      [farmId],
    );
    expect((audit.rows as Array<{ action: string }>).map((row) => row.action)).toEqual([
      "farm.registered",
      "supervisor.created",
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(ownerPassword);
    expect(JSON.stringify(audit.rows)).not.toContain(supervisorPassword);

    // A newly registered Owner can immediately use the returned session. The
    // bootstrap helper must not create a second default Owner in this farm.
    const ownerMe = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      headers: { authorization: `Bearer ${result.token}` },
    });
    expect(ownerMe.statusCode).toBe(200);
    expect(ownerMe.json()).toEqual(expect.objectContaining({
      username: "greenhills.owner",
      role: "admin",
      farm_id: farmId,
    }));

    const ownerLogin = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { username: "greenhills.owner", password: ownerPassword },
    });
    expect(ownerLogin.statusCode).toBe(200);
    const ownerCount = await db.query(
      "SELECT COUNT(*)::int AS count FROM users WHERE farm_id=$1 AND role='admin'",
      [farmId],
    );
    expect((ownerCount.rows[0] as { count: number }).count).toBe(1);

    // This is the intended day-one field-phone path: a Supervisor uses the
    // official farm name and their credentials once, then gets a device token.
    const fieldJoin = await app.inject({
      method: "POST",
      url: "/api/field-devices/join-existing-farm",
      payload: {
        farm_name: "green hills tea farm",
        username: "GREENHILLS.SUPERVISOR",
        password: supervisorPassword,
        device_id: crypto.randomUUID(),
      },
    });
    expect(fieldJoin.statusCode).toBe(200);
    expect(fieldJoin.json()).toEqual(expect.objectContaining({
      ok: true,
      farm_id: farmId,
      name: "Green Hills Tea Farm",
      username: "greenhills.supervisor",
      device_token: expect.stringMatching(/^[A-Za-z0-9_-]{32,}$/),
    }));
  });

  it("rejects invalid or internally conflicting setup details without creating partial records", async () => {
    const db = await getDb();
    const beforeFarms = await db.query("SELECT COUNT(*)::int AS count FROM farms");
    const beforeUsers = await db.query("SELECT COUNT(*)::int AS count FROM users");

    const invalidPassword = await app.inject({
      method: "POST",
      url: "/api/admin/register-farm",
      payload: {
        farm_name: "Invalid Setup Farm",
        owner_username: "invalid-owner",
        owner_password: "short",
        supervisor_username: "invalid-supervisor",
        supervisor_password: supervisorPassword,
      },
    });
    expect(invalidPassword.statusCode).toBe(400);
    expect(invalidPassword.json()).toEqual({ error: "owner password must be 12–128 characters" });

    const sameUsername = await app.inject({
      method: "POST",
      url: "/api/admin/register-farm",
      payload: {
        farm_name: "Conflicting Setup Farm",
        owner_username: "same-user",
        owner_password: ownerPassword,
        supervisor_username: "same-user",
        supervisor_password: supervisorPassword,
      },
    });
    expect(sameUsername.statusCode).toBe(400);
    expect(sameUsername.json()).toEqual({ error: "owner and supervisor usernames must be different" });

    const afterFarms = await db.query("SELECT COUNT(*)::int AS count FROM farms");
    const afterUsers = await db.query("SELECT COUNT(*)::int AS count FROM users");
    expect(afterFarms.rows).toEqual(beforeFarms.rows);
    expect(afterUsers.rows).toEqual(beforeUsers.rows);
  });

  it("keeps official farm names and account names unambiguous", async () => {
    const duplicateFarm = await app.inject({
      method: "POST",
      url: "/api/admin/register-farm",
      payload: {
        farm_name: "  GREEN HILLS TEA FARM ",
        owner_username: "another-owner",
        owner_password: ownerPassword,
        supervisor_username: "another-supervisor",
        supervisor_password: supervisorPassword,
      },
    });
    expect(duplicateFarm.statusCode).toBe(409);
    expect(duplicateFarm.json()).toEqual({
      error: "that official farm name is already registered; choose a different name",
    });

    const duplicateOwner = await app.inject({
      method: "POST",
      url: "/api/admin/register-farm",
      payload: {
        farm_name: "Second Green Farm",
        owner_username: "GREENHILLS.OWNER",
        owner_password: ownerPassword,
        supervisor_username: "second-supervisor",
        supervisor_password: supervisorPassword,
      },
    });
    expect(duplicateOwner.statusCode).toBe(409);
    expect(duplicateOwner.json()).toEqual({
      error: "that owner username is unavailable; choose a different one",
    });

    const db = await getDb();
    const existing = await db.query("SELECT farm_id FROM farms WHERE farm_id=$1", [farmId]);
    expect(existing.rows).toHaveLength(1);
  });
});
