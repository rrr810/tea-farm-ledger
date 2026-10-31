import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/index.js";
import { closeDb, getDb, runMigrations, withTransaction } from "@tea-ledger/database";
import { hashSupervisorPassword } from "../apps/api/src/supervisor-auth.js";

const farmId = "00000000-0000-4000-a000-000000000091";
const userId = "00000000-0000-4000-a000-000000000092";
const username = "identity-admin";
const password = "identity-test-password";
const supervisorUserId = "00000000-0000-4000-a000-000000000095";
const supervisorUsername = "nandi-supervisor";
const supervisorPassword = "Nandi Supervisor Password 2026";
let app: FastifyInstance;

async function loginSupervisor(): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/api/supervisor/login",
    payload: {
      farm_id: farmId,
      username: supervisorUsername,
      password: supervisorPassword,
    },
  });
  expect(login.statusCode).toBe(200);
  return (login.json() as { token: string }).token;
}

function passwordHash(value: string, salt = "identity-test-salt"): string {
  return `${salt}:${createHash("sha256").update(salt + value).digest("hex")}`;
}

beforeAll(async () => {
  process.env.USE_PGLITE = "true";
  process.env.SESSION_SECRET = "identity-api-test-secret-that-is-long-enough";
  const db = await getDb();
  await runMigrations(db);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [
    farmId,
    "Identity API Test Farm",
  ]);
  await db.query(
    "INSERT INTO users (user_id, farm_id, role, username, password_hash) VALUES ($1,$2,'admin',$3,$4)",
    [userId, farmId, username, passwordHash(password)],
  );
  await db.query(
    "INSERT INTO users (user_id, farm_id, role, username, password_hash) VALUES ($1,$2,'supervisor',$3,$4)",
    [
      supervisorUserId,
      farmId,
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
});

describe("worker identity HTTP boundary", () => {
  it("requires an authenticated farm-bound Supervisor to write identity while keeping it out of public data", async () => {
    const identityPayload = {
        full_name: "API Identity Worker",
        phone: "0712345691",
        consent: true,
        consent_author: "spoofed-client-author",
        national_id_number: "87654321",
        identity_consent: true,
        identity_consent_author: "spoofed-client-author",
      };
    const anonymousCreate = await app.inject({
      method: "POST",
      url: `/api/farms/${farmId}/workers`,
      payload: identityPayload,
    });
    expect(anonymousCreate.statusCode).toBe(401);

    const supervisorToken = await loginSupervisor();
    const create = await app.inject({
      method: "POST",
      url: `/api/farms/${farmId}/workers`,
      headers: { authorization: `Bearer ${supervisorToken}` },
      payload: identityPayload,
    });
    expect(create.statusCode).toBe(200);
    const created = create.json() as { worker_id: string; identity_recorded: boolean };
    expect(created.identity_recorded).toBe(true);

    const publicList = await app.inject({
      method: "GET",
      url: `/api/farms/${farmId}/workers`,
    });
    expect(publicList.statusCode).toBe(200);
    expect(publicList.body).not.toContain("87654321");
    expect(publicList.body).not.toContain("national_id");

    const unauthenticated = await app.inject({
      method: "GET",
      url: `/api/admin/farms/${farmId}/workers/${created.worker_id}`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.body).not.toContain("87654321");

    const login = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { username, password },
    });
    expect(login.statusCode).toBe(200);
    const { token } = login.json() as { token: string };

    const summary = await app.inject({
      method: "GET",
      url: `/api/admin/farms/${farmId}/workers`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.body).not.toContain("87654321");
    expect(summary.json().workers[0]).toEqual(
      expect.objectContaining({ has_identity: true, has_id_photo: false }),
    );

    const profile = await app.inject({
      method: "GET",
      url: `/api/admin/farms/${farmId}/workers/${created.worker_id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().worker.national_id_number).toBe("87654321");

    const db = await getDb();
    const audit = await db.query(
      "SELECT action, actor, detail FROM audit_log WHERE farm_id=$1 AND target=$2 ORDER BY id ASC",
      [farmId, created.worker_id],
    );
    expect((audit.rows as Array<{ action: string }>).map((row) => row.action)).toEqual(
      expect.arrayContaining(["worker.identity.recorded", "worker.identity.viewed"]),
    );
    expect(
      (audit.rows as Array<{ action: string; actor: string }>).find(
        (row) => row.action === "worker.identity.recorded",
      )?.actor,
    ).toBe(supervisorUsername);
    expect(JSON.stringify(audit.rows)).not.toContain("87654321");

    const duplicateId = await app.inject({
      method: "POST",
      url: `/api/farms/${farmId}/workers`,
      headers: { authorization: `Bearer ${supervisorToken}` },
      payload: {
        full_name: "Would Be Partial Worker",
        phone: "0712345699",
        consent: true,
        national_id_number: "87654321",
        identity_consent: true,
      },
    });
    expect(duplicateId.statusCode).toBe(409);
    const afterDuplicate = await app.inject({
      method: "GET",
      url: `/api/farms/${farmId}/workers`,
    });
    expect(afterDuplicate.body).not.toContain("Would Be Partial Worker");
  });

  it("lets the supervisor complete an existing worker gradually without putting identity data in events", async () => {
    const existingWorkerId = "00000000-0000-4000-a000-000000000093";
    const db = await getDb();
    await db.query(
      `INSERT INTO workers (worker_id, farm_id, full_name, phone_e164, status, verified, consent_at, consent_author)
       VALUES ($1,$2,$3,$4,'active',false,NOW(),'supervisor')`,
      [existingWorkerId, farmId, "Existing Profile Worker", "+254712345692"],
    );

    const identityPayload = {
      national_id_number: "87654322",
      identity_consent: true,
      identity_consent_author: "spoofed-client-author",
    };
    const anonymousCompletion = await app.inject({
      method: "POST",
      url: `/api/farms/${farmId}/workers/${existingWorkerId}/identity`,
      payload: identityPayload,
    });
    expect(anonymousCompletion.statusCode).toBe(401);

    const supervisorToken = await loginSupervisor();
    const complete = await app.inject({
      method: "POST",
      url: `/api/farms/${farmId}/workers/${existingWorkerId}/identity`,
      headers: { authorization: `Bearer ${supervisorToken}` },
      payload: identityPayload,
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toEqual(
      expect.objectContaining({ identity_recorded: true, id_photo_recorded: false }),
    );

    const crossFarmCompletion = await app.inject({
      method: "POST",
      url: "/api/farms/00000000-0000-4000-a000-000000000094/workers/00000000-0000-4000-a000-000000000096/identity",
      headers: { authorization: `Bearer ${supervisorToken}` },
      payload: identityPayload,
    });
    expect(crossFarmCompletion.statusCode).toBe(403);

    const events = await db.query(
      "SELECT payload FROM events WHERE farm_id=$1 AND payload::text LIKE $2",
      [farmId, "%87654322%"],
    );
    expect(events.rows).toEqual([]);

    const login = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { username, password },
    });
    const { token } = login.json() as { token: string };
    const wrongFarm = await app.inject({
      method: "GET",
      url: "/api/admin/farms/00000000-0000-4000-a000-000000000094/workers",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(wrongFarm.statusCode).toBe(403);

    const profile = await app.inject({
      method: "GET",
      url: `/api/admin/farms/${farmId}/workers/${existingWorkerId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().worker.national_id_number).toBe("87654322");
  });

  it("lets an Admin provision/reset a farm-bound supervisor and throttles failed sign-ins", async () => {
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { username, password },
    });
    const adminToken = (adminLogin.json() as { token: string }).token;
    const created = await app.inject({
      method: "POST",
      url: `/api/admin/farms/${farmId}/supervisors`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        username: "field-account",
        password: "First Field Password 2026",
      },
    });
    expect(created.statusCode).toBe(201);
    const account = created.json() as { user_id: string; username: string };
    expect(account.username).toBe("field-account");

    const createdLogin = await app.inject({
      method: "POST",
      url: "/api/supervisor/login",
      payload: {
        farm_id: farmId,
        username: "field-account",
        password: "First Field Password 2026",
      },
    });
    expect(createdLogin.statusCode).toBe(200);
    const oldSessionToken = (createdLogin.json() as { token: string }).token;
    const db = await getDb();
    const storedSession = await db.query(
      "SELECT token FROM sessions WHERE user_id=$1 AND role='supervisor' ORDER BY created_at DESC LIMIT 1",
      [account.user_id],
    );
    expect((storedSession.rows[0] as { token: string }).token).toMatch(/^supervisor:/);
    expect((storedSession.rows[0] as { token: string }).token).not.toBe(oldSessionToken);

    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/farms/${farmId}/supervisors/${account.user_id}/reset-password`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { password: "Second Field Password 2026" },
    });
    expect(reset.statusCode).toBe(200);

    const revokedSession = await app.inject({
      method: "GET",
      url: `/api/supervisor/farms/${farmId}/access`,
      headers: { authorization: `Bearer ${oldSessionToken}` },
    });
    expect(revokedSession.statusCode).toBe(401);

    const stalePassword = await app.inject({
      method: "POST",
      url: "/api/supervisor/login",
      payload: {
        farm_id: farmId,
        username: "field-account",
        password: "First Field Password 2026",
      },
    });
    expect(stalePassword.statusCode).toBe(401);
    const newPassword = await app.inject({
      method: "POST",
      url: "/api/supervisor/login",
      payload: {
        farm_id: farmId,
        username: "field-account",
        password: "Second Field Password 2026",
      },
    });
    expect(newPassword.statusCode).toBe(200);

    const unknownFarm = await app.inject({
      method: "POST",
      url: "/api/supervisor/login",
      payload: {
        farm_id: "00000000-0000-4000-a000-000000000099",
        username: "field-account",
        password: "Second Field Password 2026",
      },
    });
    expect(unknownFarm.statusCode).toBe(401);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/supervisor/login",
        payload: {
          farm_id: farmId,
          username: "unknown-field-user",
          password: "Wrong Password That Is Long Enough",
        },
      });
      expect(failed.statusCode).toBe(401);
    }
    const locked = await app.inject({
      method: "POST",
      url: "/api/supervisor/login",
      payload: {
        farm_id: farmId,
        username: "unknown-field-user",
        password: "Wrong Password That Is Long Enough",
      },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toBeTruthy();
  });

  it("rolls related database writes back when an identity intake transaction fails", async () => {
    const rollbackWorkerId = "00000000-0000-4000-a000-000000000097";
    await expect(
      withTransaction(async (db) => {
        await db.query(
          `INSERT INTO workers
             (worker_id, farm_id, full_name, phone_e164, status, verified, consent_at, consent_author)
           VALUES ($1,$2,$3,$4,'active',false,NOW(),'supervisor')`,
          [rollbackWorkerId, farmId, "Rolled Back Worker", "+254712345697"],
        );
        throw new Error("simulate private identity persistence failure");
      }),
    ).rejects.toThrow("simulate private identity persistence failure");
    const db = await getDb();
    const result = await db.query("SELECT worker_id FROM workers WHERE worker_id=$1", [
      rollbackWorkerId,
    ]);
    expect(result.rows).toEqual([]);
  });
});
