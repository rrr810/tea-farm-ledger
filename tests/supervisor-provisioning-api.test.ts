import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/index.js";
import { closeDb, getDb, runMigrations } from "@tea-ledger/database";

const farmId = "00000000-0000-4000-a000-000000000731";
const adminId = "00000000-0000-4000-a000-000000000732";
const adminUsername = "provision-owner";
const adminPassword = "Provision Owner Password 2026";
const supervisorPassword = "Temporary Supervisor Password 2026";
const rotatedPassword = "Rotated Supervisor Password 2026";
let app: FastifyInstance;

function legacyPasswordHash(value: string, salt = "provisioning-test-salt"): string {
  return `${salt}:${createHash("sha256").update(salt + value).digest("hex")}`;
}

beforeAll(async () => {
  process.env.USE_PGLITE = "true";
  process.env.SESSION_SECRET = "supervisor-provisioning-test-secret-that-is-long-enough";
  const db = await getDb();
  await runMigrations(db);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [farmId, "Provisioning test farm"]);
  await db.query(
    "INSERT INTO users (user_id, farm_id, role, username, password_hash) VALUES ($1,$2,'admin',$3,$4)",
    [adminId, farmId, adminUsername, legacyPasswordHash(adminPassword)],
  );
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb();
  delete process.env.SESSION_SECRET;
});

describe("Supervisor provisioning and sign-in", () => {
  it("lets an authenticated farm owner provision, sign in, and reset a Supervisor account", async () => {
    const ownerLogin = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { username: adminUsername, password: adminPassword },
    });
    expect(ownerLogin.statusCode).toBe(200);
    const ownerToken = (ownerLogin.json() as { token: string }).token;

    const provision = await app.inject({
      method: "POST",
      url: `/api/admin/farms/${farmId}/supervisors`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { username: "Field.Supervisor", password: supervisorPassword },
    });
    expect(provision.statusCode).toBe(201);
    expect(provision.json()).toEqual(expect.objectContaining({
      farm_id: farmId,
      role: "supervisor",
      username: "field.supervisor",
    }));
    const supervisorId = (provision.json() as { user_id: string }).user_id;

    const supervisorLogin = await app.inject({
      method: "POST",
      url: "/api/supervisor/login",
      payload: {
        farm_id: farmId,
        username: "FIELD.SUPERVISOR",
        password: supervisorPassword,
      },
    });
    expect(supervisorLogin.statusCode).toBe(200);
    expect(supervisorLogin.json()).toEqual(expect.objectContaining({
      ok: true,
      farm_id: farmId,
      role: "supervisor",
      username: "field.supervisor",
    }));

    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/farms/${farmId}/supervisors/${supervisorId}/reset-password`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { password: rotatedPassword },
    });
    expect(reset.statusCode).toBe(200);

    const oldPassword = await app.inject({
      method: "POST",
      url: "/api/supervisor/login",
      payload: { farm_id: farmId, username: "field.supervisor", password: supervisorPassword },
    });
    expect(oldPassword.statusCode).toBe(401);

    const newPassword = await app.inject({
      method: "POST",
      url: "/api/supervisor/login",
      payload: { farm_id: farmId, username: "field.supervisor", password: rotatedPassword },
    });
    expect(newPassword.statusCode).toBe(200);
  });
});
