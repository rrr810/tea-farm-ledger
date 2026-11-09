import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/index.js";
import { closeDb, getDb, runMigrations } from "@tea-ledger/database";

let app: FastifyInstance;

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

describe("retired public Owner-led farm registration", () => {
  it("fails closed before creating any farm or account", async () => {
    const db = await getDb();
    const beforeFarms = await db.query("SELECT COUNT(*)::int AS count FROM farms");
    const beforeUsers = await db.query("SELECT COUNT(*)::int AS count FROM users");

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/register-farm",
      payload: {
        farm_name: "Old Public Wizard Farm",
        owner_username: "old-public-owner",
        owner_password: "Old Public Owner Password 2026",
        supervisor_username: "old-public-supervisor",
        supervisor_password: "Old Public Supervisor Password 2026",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "new farms can be created only from the Master Admin console",
    });
    const afterFarms = await db.query("SELECT COUNT(*)::int AS count FROM farms");
    const afterUsers = await db.query("SELECT COUNT(*)::int AS count FROM users");
    expect(afterFarms.rows).toEqual(beforeFarms.rows);
    expect(afterUsers.rows).toEqual(beforeUsers.rows);
  });
});
