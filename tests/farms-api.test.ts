import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/index.js";
import { closeDb, getDb, runMigrations } from "@tea-ledger/database";
import { issueFarmDeviceAccess } from "../apps/api/src/device-auth.js";

let app: FastifyInstance;
const farmId = "00000000-0000-4000-a000-000000000071";
const deviceId = "00000000-0000-4000-a000-000000000072";
let deviceToken = "";

afterAll(async () => {
  await app?.close();
  await closeDb();
});

beforeAll(async () => {
  process.env.USE_PGLITE = "true";
  const db = await getDb();
  await runMigrations(db);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [farmId, "Nandi Tea Estate"]);
  deviceToken = (await issueFarmDeviceAccess({ farmId, deviceId })).deviceToken;
  app = await buildApp();
  await app.ready();
});

describe("farm identity and Master-only registration", () => {
  it("keeps the existing device-scoped farm-name lookup narrow", async () => {
    const anonymousLookup = await app.inject({
      method: "GET",
      url: `/api/farms/${farmId}`,
    });
    expect(anonymousLookup.statusCode).toBe(401);

    const lookup = await app.inject({
      method: "GET",
      url: `/api/farms/${farmId}`,
      headers: {
        "x-tea-device-id": deviceId,
        "x-tea-device-token": deviceToken,
      },
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toEqual({ farm_id: farmId, name: "Nandi Tea Estate" });

    const renameAttempt = await app.inject({
      method: "PATCH",
      url: `/api/farms/${farmId}`,
      payload: { name: "Different Farm" },
    });
    expect(renameAttempt.statusCode).toBe(404);
  });

  it("rejects the old field-device new-farm path", async () => {
    const before = await (await getDb()).query("SELECT COUNT(*)::int AS count FROM farms");
    const response = await app.inject({
      method: "POST",
      url: "/api/farms",
      payload: {
        name: "Field Device Bypass Farm",
        device_id: "00000000-0000-4000-a000-000000000073",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "new farms can be created only from the Master Admin console",
    });
    const after = await (await getDb()).query("SELECT COUNT(*)::int AS count FROM farms");
    expect(after.rows).toEqual(before.rows);
  });
});
