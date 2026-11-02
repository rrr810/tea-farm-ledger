import type { FastifyInstance } from "fastify";
import { getDb } from "@tea-ledger/database";
import { validateFarmName } from "@tea-ledger/core";
import { randomUUID } from "node:crypto";

type FarmRow = { farm_id: string; name: string };

/**
 * Farm registration deliberately has no rename route. The owner chooses the
 * canonical name once during setup; field devices can read that name but never
 * edit it locally or through the API.
 */
export async function farmsRoutes(app: FastifyInstance) {
  app.post("/api/farms", async (req, reply) => {
    const body = req.body as { name?: unknown };
    const rawName = typeof body?.name === "string" ? body.name : "";
    const validation = validateFarmName(rawName);
    if (!validation.valid) return reply.status(400).send({ error: validation.reason });

    const name = rawName.trim();
    const farmId = randomUUID();
    const db = await getDb();
    await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [farmId, name]);
    await db.query(
      "INSERT INTO rates (farm_id, effective_from, rate_cents_per_kg) VALUES ($1,'2020-01-01',900) ON CONFLICT DO NOTHING",
      [farmId],
    );
    return { farm_id: farmId, name };
  });

  app.get("/api/farms", async () => {
    const db = await getDb();
    const res = await db.query("SELECT farm_id, name, created_at FROM farms ORDER BY created_at ASC");
    return { farms: res.rows };
  });

  // The PWA uses this narrow lookup to replace any stale browser display label
  // with the canonical, server-stored farm name after first setup.
  app.get("/api/farms/:farmId", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const db = await getDb();
    const result = await db.query(
      "SELECT farm_id, name FROM farms WHERE farm_id=$1 LIMIT 1",
      [farmId],
    );
    const farm = (result.rows as FarmRow[])[0];
    if (!farm) return reply.status(404).send({ error: "farm not found" });
    return farm;
  });
}
