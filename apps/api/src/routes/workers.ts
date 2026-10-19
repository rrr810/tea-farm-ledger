import type { FastifyInstance } from "fastify";
import { getDb } from "@tea-ledger/database";
import { createWorker, listWorkers, startEmployment, endEmployment, listEmployment } from "@tea-ledger/database";

export async function workersRoutes(app: FastifyInstance) {
  app.get("/api/farms/:farmId/workers", async (req) => {
    const { farmId } = req.params as { farmId: string };
    const workers = await listWorkers(farmId);
    return { workers };
  });

  app.post("/api/farms/:farmId/workers", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const body = req.body as { full_name?: string; phone?: string; consent?: boolean; consent_author?: string };
    if (!body.full_name) return reply.status(400).send({ error: "full_name required" });
    if (!body.phone) return reply.status(400).send({ error: "phone required" });
    if (!body.consent) return reply.status(400).send({ error: "consent required — supervisor checkbox + timestamp/author needed per Decision 18" });
    try {
      const res = await createWorker({ farmId, fullName: body.full_name, phone: body.phone, consentAuthor: body.consent_author ?? "supervisor" });
      // Start employment period inclusive from today (Africa/Nairobi)
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
      await startEmployment({ workerId: res.worker_id, farmId, startDate: today });
      return res;
    } catch (e) {
      return reply.status(409).send({ error: String((e as Error).message) });
    }
  });

  app.post("/api/workers/:workerId/hire", async (req, reply) => {
    const { workerId } = req.params as { workerId: string };
    const body = req.body as { farm_id?: string; start_date?: string };
    if (!body.farm_id || !body.start_date) return reply.status(400).send({ error: "farm_id and start_date required" });
    try {
      const res = await startEmployment({ workerId, farmId: body.farm_id, startDate: body.start_date });
      return res;
    } catch (e) { return reply.status(409).send({ error: String((e as Error).message) }); }
  });

  app.post("/api/workers/:workerId/fire", async (req, reply) => {
    const { workerId } = req.params as { workerId: string };
    const body = req.body as { end_date?: string; reason?: string };
    if (!body.end_date) return reply.status(400).send({ error: "end_date required (inclusive)" });
    try {
      const res = await endEmployment({ workerId, endDate: body.end_date, reason: body.reason });
      return res;
    } catch (e) { return reply.status(409).send({ error: String((e as Error).message) }); }
  });

  app.get("/api/workers/:workerId/employment", async (req) => {
    const { workerId } = req.params as { workerId: string };
    const periods = await listEmployment(workerId);
    return { periods };
  });
}
