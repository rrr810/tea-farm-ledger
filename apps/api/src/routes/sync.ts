import type { FastifyInstance } from "fastify";
import { getDb } from "@tea-ledger/database";
import { pushEvents, pullEvents } from "@tea-ledger/database";
export async function syncRoutes(app: FastifyInstance) {
  app.post("/api/sync/push", async (req, reply) => {
    const body = req.body as { events?: unknown[] };
    if (!Array.isArray(body?.events)) return reply.status(400).send({ error: "events array required" });
    const events = body.events as import("@tea-ledger/core").LedgerEvent[];
    for (const ev of events) {
      if (!ev.event_id || !ev.farm_id || !ev.event_type || !ev.business_date) {
        return reply.status(400).send({ error: "invalid event", event_id: ev.event_id });
      }
    }
    const db = await getDb();
    const result = await pushEvents(events, db as Awaited<ReturnType<typeof getDb>>);
    return result;
  });
  app.get("/api/sync/pull", async (req, reply) => {
    const qs = req.query as { farm_id?: string; since?: string; limit?: string };
    if (!qs.farm_id) return reply.status(400).send({ error: "farm_id required" });
    const since = qs.since ? Number(qs.since) : null;
    const limit = qs.limit ? Math.min(Number(qs.limit), 500) : 100;
    const db = await getDb();
    const result = await pullEvents(since, qs.farm_id, limit, db as Awaited<ReturnType<typeof getDb>>);
    return result;
  });
  app.get("/api/farms/:farmId/conflicts", async (req) => {
    const { farmId } = req.params as { farmId: string };
    const db = await getDb();
    const res = await db.query("SELECT * FROM events WHERE farm_id = $1 AND conflict_flag = true ORDER BY seq DESC", [farmId]);
    return { conflicts: res.rows };
  });
  app.get("/api/farms/:farmId/corrections", async (req) => {
    const { farmId } = req.params as { farmId: string };
    const db = await getDb();
    const res = await db.query("SELECT * FROM events WHERE farm_id = $1 AND correction_flag = true ORDER BY seq DESC", [farmId]);
    return { corrections: res.rows };
  });
}
