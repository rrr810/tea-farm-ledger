import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/index.js";
import { closeDb, getDb, runMigrations } from "@tea-ledger/database";

let app: FastifyInstance;

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
  it("stores a canonical first-time name and exposes only the narrow display lookup", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/farms",
      payload: { name: "  Nandi Tea Estate  " },
    });

    expect(created.statusCode).toBe(200);
    const farm = created.json() as { farm_id: string; name: string };
    expect(farm.farm_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(farm.name).toBe("Nandi Tea Estate");

    const lookup = await app.inject({
      method: "GET",
      url: `/api/farms/${farm.farm_id}`,
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
    });
    expect(afterRenameAttempt.json()).toEqual({
      farm_id: farm.farm_id,
      name: "Nandi Tea Estate",
    });
  });

  it("rejects blank, control-character, and oversized names before creating a farm", async () => {
    for (const name of [" ", "Nandi\nTea", "A".repeat(81)]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/farms",
        payload: { name },
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
