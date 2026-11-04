import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/index.js";
import { closeDb, getDb, runMigrations } from "@tea-ledger/database";

let app: FastifyInstance;
const deviceId = "00000000-0000-4000-a000-000000000071";

afterAll(async () => {
  await app?.close();
  await closeDb();
});

beforeAll(async () => {
  process.env.USE_PGLITE = "true";
  const db = await getDb();
  await runMigrations(db);
  app = await buildApp();
  await app.ready();
});

describe("farm registration identity", () => {
  it("stores a canonical first-time name and gives only its enrolled device the narrow display lookup", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/farms",
      payload: { name: "  Nandi Tea Estate  ", device_id: deviceId },
    });

    expect(created.statusCode).toBe(200);
    const farm = created.json() as { farm_id: string; name: string; device_token: string };
    expect(farm.farm_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(farm.name).toBe("Nandi Tea Estate");
    expect(farm.device_token).toMatch(/^[A-Za-z0-9_-]{30,}$/);

    const anonymousLookup = await app.inject({
      method: "GET",
      url: `/api/farms/${farm.farm_id}`,
    });
    expect(anonymousLookup.statusCode).toBe(401);

    const headers = {
      "x-tea-device-id": deviceId,
      "x-tea-device-token": farm.device_token,
    };
    const lookup = await app.inject({
      method: "GET",
      url: `/api/farms/${farm.farm_id}`,
      headers,
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toEqual({ farm_id: farm.farm_id, name: "Nandi Tea Estate" });

    // There is deliberately no rename API; field devices can only read the
    // canonical server name and render it as a locked label.
    const renameAttempt = await app.inject({
      method: "PATCH",
      url: `/api/farms/${farm.farm_id}`,
      payload: { name: "Different Farm" },
    });
    expect(renameAttempt.statusCode).toBe(404);

    const afterRenameAttempt = await app.inject({
      method: "GET",
      url: `/api/farms/${farm.farm_id}`,
      headers,
    });
    expect(afterRenameAttempt.json()).toEqual({
      farm_id: farm.farm_id,
      name: "Nandi Tea Estate",
    });
  });

  it("rejects missing device enrolment, blank, control-character, and oversized names before creating a farm", async () => {
    const missingDevice = await app.inject({
      method: "POST",
      url: "/api/farms",
      payload: { name: "Nandi Tea" },
    });
    expect(missingDevice.statusCode).toBe(400);

    for (const name of [" ", "Nandi\nTea", "A".repeat(81)]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/farms",
        payload: { name, device_id: deviceId },
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
