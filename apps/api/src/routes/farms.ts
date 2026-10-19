import type { FastifyInstance } from "fastify";
import { getDb } from "@tea-ledger/database";
import { randomUUID } from "node:crypto";
export async function farmsRoutes(app: FastifyInstance) {
  app.post("/api/farms", async (req, reply) => {
    const body = req.body as { name?: string };
    if (!body?.name) return reply.status(400).send({ error: "name required" });
    const farmId = randomUUID();
    const db = await getDb();
    await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [farmId, body.name]);
    await db.query("INSERT INTO rates (farm_id, effective_from, rate_cents_per_kg) VALUES ($1,'2020-01-01',900) ON CONFLICT DO NOTHING", [farmId]);
    return { farm_id: farmId, name: body.name };
  });
  app.get("/api/farms", async () => {
    const db = await getDb();
    const res = await db.query("SELECT farm_id, name, created_at FROM farms ORDER BY created_at ASC");
    return { farms: res.rows };
  });
}
