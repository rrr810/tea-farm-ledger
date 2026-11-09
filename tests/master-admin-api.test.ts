import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/index.js";
import { closeDb, getDb, runMigrations } from "@tea-ledger/database";

const rootFarmId = "00000000-0000-4000-a000-000000000901";
const otherFarmId = "00000000-0000-4000-a000-000000000902";
const rootUserId = "00000000-0000-4000-a000-000000000903";
const otherOwnerId = "00000000-0000-4000-a000-000000000904";
const rootUsername = "trusted-root";
const rootPassword = "Trusted Root Password 2026";
const otherOwnerUsername = "retained-owner";
const otherOwnerPassword = "Retained Owner Password 2026";
const masterEmail = "master@example.test";
const masterPassword = "Master Console Password 2026";
let app: FastifyInstance;

function legacyPasswordHash(value: string, salt: string): string {
  return `${salt}:${createHash("sha256").update(salt + value).digest("hex")}`;
}

async function loginOwner(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { token: string }).token;
}

beforeAll(async () => {
  process.env.USE_PGLITE = "true";
  process.env.ADMIN_USERNAME = rootUsername;
  const db = await getDb();
  await runMigrations(db);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [rootFarmId, "Root Admin Farm"]);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [otherFarmId, "Retained Owner Farm"]);
  await db.query(
    "INSERT INTO users (user_id, farm_id, role, username, password_hash) VALUES ($1,$2,'admin',$3,$4)",
    [rootUserId, rootFarmId, rootUsername, legacyPasswordHash(rootPassword, "master-root-salt")],
  );
  await db.query(
    "INSERT INTO users (user_id, farm_id, role, username, password_hash) VALUES ($1,$2,'admin',$3,$4)",
    [otherOwnerId, otherFarmId, otherOwnerUsername, legacyPasswordHash(otherOwnerPassword, "retained-owner-salt")],
  );
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb();
  delete process.env.ADMIN_USERNAME;
});

describe("central Master Admin and generated Supervisor provisioning", () => {
  it("activates only from the trusted existing Admin, preserving retained Owner access", async () => {
    const rootToken = await loginOwner(rootUsername, rootPassword);
    const retainedOwnerToken = await loginOwner(otherOwnerUsername, otherOwnerPassword);

    const rootStatus = await app.inject({
      method: "GET",
      url: "/api/platform/activation-status",
      headers: { authorization: `Bearer ${rootToken}` },
    });
    expect(rootStatus.statusCode).toBe(200);
    expect(rootStatus.json()).toEqual({ master_active: false, can_activate: true });

    const retainedStatus = await app.inject({
      method: "GET",
      url: "/api/platform/activation-status",
      headers: { authorization: `Bearer ${retainedOwnerToken}` },
    });
    expect(retainedStatus.statusCode).toBe(200);
    expect(retainedStatus.json()).toEqual({ master_active: false, can_activate: false });

    const deniedActivation = await app.inject({
      method: "POST",
      url: "/api/platform/activate",
      headers: { authorization: `Bearer ${retainedOwnerToken}` },
      payload: { email: masterEmail, password: masterPassword },
    });
    expect(deniedActivation.statusCode).toBe(403);

    const activation = await app.inject({
      method: "POST",
      url: "/api/platform/activate",
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { email: masterEmail.toUpperCase(), password: masterPassword },
    });
    expect(activation.statusCode).toBe(201);
    const result = activation.json() as { token: string; email: string; role: string };
    expect(result).toEqual(expect.objectContaining({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{32,}$/),
      email: masterEmail,
      role: "platform_admin",
    }));
    const db = await getDb();
    const platformRows = await db.query(
      "SELECT email, password_hash, activated_by_user_id FROM platform_admins",
    );
    expect(platformRows.rows).toHaveLength(1);
    expect(platformRows.rows[0]).toEqual(expect.objectContaining({
      email: masterEmail,
      activated_by_user_id: rootUserId,
      password_hash: expect.stringMatching(/^scrypt-v1\$/),
    }));
    expect(JSON.stringify(platformRows.rows)).not.toContain(masterPassword);
    // The database itself prevents a race from creating a second Master.
    await expect(db.query(
      `INSERT INTO platform_admins
         (platform_admin_id, email, email_canonical, password_hash, activated_by_user_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), "second@example.test", "second@example.test", "scrypt-v1$test$test", rootUserId],
    )).rejects.toThrow(/unique/i);

    const secondActivation = await app.inject({
      method: "POST",
      url: "/api/platform/activate",
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { email: "another@example.test", password: masterPassword },
    });
    expect(secondActivation.statusCode).toBe(409);

    // The retained farm Owner still has their original, narrowly scoped access.
    const retainedFarms = await app.inject({
      method: "GET",
      url: "/api/farms",
      headers: { authorization: `Bearer ${retainedOwnerToken}` },
    });
    expect(retainedFarms.statusCode).toBe(200);
    expect(retainedFarms.json()).toEqual({
      farms: [{ farm_id: otherFarmId, name: "Retained Owner Farm" }],
    });
  });

  it("lets the Master sign in once, see all farms, and create a farm with a generated first Supervisor", async () => {
    const signIn = await app.inject({
      method: "POST",
      url: "/api/platform/login",
      payload: { email: masterEmail, password: masterPassword },
    });
    expect(signIn.statusCode).toBe(200);
    const masterToken = (signIn.json() as { token: string }).token;

    const masterMe = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      headers: { authorization: `Bearer ${masterToken}` },
    });
    expect(masterMe.statusCode).toBe(200);
    expect(masterMe.json()).toEqual(expect.objectContaining({
      role: "platform_admin",
      is_platform_admin: true,
      farm_id: null,
    }));

    const allFarms = await app.inject({
      method: "GET",
      url: "/api/farms",
      headers: { authorization: `Bearer ${masterToken}` },
    });
    expect(allFarms.statusCode).toBe(200);
    expect((allFarms.json() as { farms: Array<{ farm_id: string }> }).farms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ farm_id: rootFarmId }),
        expect.objectContaining({ farm_id: otherFarmId }),
      ]),
    );

    // The Master can reach retained farm controls, without turning a retained
    // Owner's browser token into cross-farm access.
    const supervisors = await app.inject({
      method: "GET",
      url: `/api/admin/farms/${otherFarmId}/supervisors`,
      headers: { authorization: `Bearer ${masterToken}` },
    });
    expect(supervisors.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/api/platform/farms",
      headers: { authorization: `Bearer ${masterToken}` },
      payload: {
        farm_name: "  Master Created Tea Farm  ",
        supervisor_name: "First Supervisor",
      },
    });
    expect(created.statusCode).toBe(201);
    const createdFarm = created.json() as {
      farm_id: string;
      name: string;
      supervisor: { user_id: string; username: string; password: string };
    };
    expect(createdFarm).toEqual(expect.objectContaining({
      farm_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      name: "Master Created Tea Farm",
      supervisor: expect.objectContaining({
        user_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        username: expect.stringMatching(/^[a-z][a-z0-9._-]{2,31}$/),
        password: expect.stringMatching(/^[A-Za-z0-9_-]{20,}$/),
      }),
    }));

    const db = await getDb();
    const accounts = await db.query(
      "SELECT role, username, password_hash FROM users WHERE farm_id=$1 ORDER BY role, username",
      [createdFarm.farm_id],
    );
    expect(accounts.rows).toHaveLength(1);
    expect(accounts.rows[0]).toEqual(expect.objectContaining({
      role: "supervisor",
      username: createdFarm.supervisor.username,
      password_hash: expect.stringMatching(/^scrypt-v1\$/),
    }));
    expect(JSON.stringify(accounts.rows)).not.toContain(createdFarm.supervisor.password);

    const reservation = await db.query(
      "SELECT canonical_name FROM farm_name_reservations WHERE farm_id=$1",
      [createdFarm.farm_id],
    );
    expect(reservation.rows).toEqual([{ canonical_name: "master created tea farm" }]);
    const rate = await db.query("SELECT rate_cents_per_kg FROM rates WHERE farm_id=$1", [createdFarm.farm_id]);
    expect(rate.rows).toEqual([{ rate_cents_per_kg: 900 }]);
    const audit = await db.query("SELECT actor, detail FROM audit_log WHERE farm_id=$1", [createdFarm.farm_id]);
    expect(JSON.stringify(audit.rows)).not.toContain(createdFarm.supervisor.password);
    expect(JSON.stringify(audit.rows)).not.toContain(masterEmail);

    // The existing field-device join flow accepts only the generated Supervisor
    // account, so no new APK or public farm-registration path is needed.
    const joined = await app.inject({
      method: "POST",
      url: "/api/field-devices/join-existing-farm",
      payload: {
        farm_name: "master created tea farm",
        username: createdFarm.supervisor.username,
        password: createdFarm.supervisor.password,
        device_id: randomUUID(),
      },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toEqual(expect.objectContaining({
      ok: true,
      farm_id: createdFarm.farm_id,
      username: createdFarm.supervisor.username,
      device_token: expect.stringMatching(/^[A-Za-z0-9_-]{32,}$/),
    }));

    const generatedAdditional = await app.inject({
      method: "POST",
      url: `/api/platform/farms/${createdFarm.farm_id}/supervisors/generate`,
      headers: { authorization: `Bearer ${masterToken}` },
      payload: { supervisor_name: "Second Supervisor" },
    });
    expect(generatedAdditional.statusCode).toBe(201);
    const additional = generatedAdditional.json() as { user_id: string; username: string; password: string };
    expect(additional.password).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const rotate = await app.inject({
      method: "POST",
      url: `/api/platform/farms/${createdFarm.farm_id}/supervisors/${additional.user_id}/generate-password`,
      headers: { authorization: `Bearer ${masterToken}` },
      payload: {},
    });
    expect(rotate.statusCode).toBe(200);
    const reset = rotate.json() as { username: string; password: string };
    expect(reset.username).toBe(additional.username);
    expect(reset.password).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(reset.password).not.toBe(additional.password);

    // Replacing access revokes the former Supervisor session and its field
    // device while returning a new one-time generated credential.
    const oldSupervisorLogin = await app.inject({
      method: "POST",
      url: "/api/supervisor/login",
      payload: {
        farm_id: createdFarm.farm_id,
        username: additional.username,
        password: reset.password,
      },
    });
    expect(oldSupervisorLogin.statusCode).toBe(200);
    const oldSupervisorToken = (oldSupervisorLogin.json() as { token: string }).token;
    const oldSupervisorDeviceId = randomUUID();
    const oldDeviceEnrollment = await app.inject({
      method: "POST",
      url: `/api/farms/${createdFarm.farm_id}/devices/enroll`,
      headers: { authorization: `Bearer ${oldSupervisorToken}` },
      payload: { device_id: oldSupervisorDeviceId },
    });
    expect(oldDeviceEnrollment.statusCode).toBe(200);

    const replaced = await app.inject({
      method: "POST",
      url: `/api/platform/farms/${createdFarm.farm_id}/supervisors/${additional.user_id}/replace`,
      headers: { authorization: `Bearer ${masterToken}` },
      payload: { supervisor_name: "Replacement Supervisor" },
    });
    expect(replaced.statusCode).toBe(201);
    const replacement = replaced.json() as { user_id: string; username: string; password: string; replaced_user_id: string };
    expect(replacement).toEqual(expect.objectContaining({
      user_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      username: expect.stringMatching(/^[a-z][a-z0-9._-]{2,31}$/),
      password: expect.stringMatching(/^[A-Za-z0-9_-]{20,}$/),
      replaced_user_id: additional.user_id,
    }));
    const oldSupervisorMe = await app.inject({
      method: "GET",
      url: "/api/supervisor/me",
      headers: { authorization: `Bearer ${oldSupervisorToken}` },
    });
    expect(oldSupervisorMe.statusCode).toBe(401);
    const oldSupervisorReLogin = await app.inject({
      method: "POST",
      url: "/api/supervisor/login",
      payload: {
        farm_id: createdFarm.farm_id,
        username: additional.username,
        password: reset.password,
      },
    });
    expect(oldSupervisorReLogin.statusCode).toBe(401);
    const supervisorAccessRows = await db.query(
      "SELECT user_id, disabled_at FROM users WHERE user_id=$1 OR user_id=$2 ORDER BY user_id",
      [additional.user_id, replacement.user_id],
    );
    expect(supervisorAccessRows.rows).toContainEqual(expect.objectContaining({
      user_id: additional.user_id,
      disabled_at: expect.anything(),
    }));
    const revokedDevice = await db.query("SELECT revoked FROM devices WHERE device_id=$1", [oldSupervisorDeviceId]);
    expect(revokedDevice.rows).toEqual([{ revoked: true }]);
    const newSupervisorLogin = await app.inject({
      method: "POST",
      url: "/api/supervisor/login",
      payload: {
        farm_id: createdFarm.farm_id,
        username: replacement.username,
        password: replacement.password,
      },
    });
    expect(newSupervisorLogin.statusCode).toBe(200);

    // A Master is not forged as a farm user when it creates a one-time device
    // pairing code; the migration records the platform creator separately.
    const linkCode = await app.inject({
      method: "POST",
      url: `/api/admin/farms/${createdFarm.farm_id}/field-device-link-codes`,
      headers: { authorization: `Bearer ${masterToken}` },
      payload: {},
    });
    expect(linkCode.statusCode).toBe(201);
    const linkRows = await db.query(
      "SELECT created_by_user_id, created_by_platform_admin_id FROM field_device_link_codes WHERE farm_id=$1",
      [createdFarm.farm_id],
    );
    expect(linkRows.rows[0]).toEqual(expect.objectContaining({
      created_by_user_id: null,
      created_by_platform_admin_id: expect.any(String),
    }));
  });

  it("fails closed for the retired public farm-registration paths", async () => {
    const publicOwnerWizard = await app.inject({
      method: "POST",
      url: "/api/admin/register-farm",
      payload: {
        farm_name: "Public Bypass Farm",
        owner_username: "public-owner",
        owner_password: "Public Owner Password 2026",
        supervisor_username: "public-supervisor",
        supervisor_password: "Public Supervisor Password 2026",
      },
    });
    expect(publicOwnerWizard.statusCode).toBe(403);

    const publicFieldWizard = await app.inject({
      method: "POST",
      url: "/api/farms",
      payload: { name: "Public Field Bypass Farm", device_id: randomUUID() },
    });
    expect(publicFieldWizard.statusCode).toBe(403);
  });
});
