import type { FastifyInstance } from "fastify";
import { getDb } from "@tea-ledger/database";
import { listSmsLog, getSmsStats, updateFarmSettings, getFarmSettings } from "@tea-ledger/sms";

export async function smsRoutes(app: FastifyInstance) {
  // GET /api/sms-log?farm_id=&limit= - mock/default preview with segments/status
  app.get("/api/sms-log", async (req) => {
    const qs = req.query as { farm_id?: string; farmId?: string; limit?: string };
    const farmId = qs.farm_id ?? qs.farmId;
    const limit = qs.limit ? Math.min(Number(qs.limit), 200) : 50;
    const rows = await listSmsLog(farmId, limit);
    return { messages: rows, count: rows.length };
  });

  app.get("/api/sms-stats", async (req) => {
    const qs = req.query as { farm_id?: string; farmId?: string };
    const farmId = qs.farm_id ?? qs.farmId;
    const stats = await getSmsStats(farmId);
    return { stats };
  });

  // Farm settings: owner/supervisor phones + sender etc.
  app.get("/api/farms/:farmId/settings", async (req) => {
    const { farmId } = req.params as { farmId: string };
    const settings = await getFarmSettings(farmId);
    const db = await getDb();
    // Also fetch owner/supervisor from farm_settings JSON extended fields
    const res = await db.query("SELECT settings FROM farm_settings WHERE farm_id=$1", [farmId]);
    const raw = (res.rows as Array<{ settings: Record<string, unknown> }>)[0]?.settings ?? {};
    return { farm_id: farmId, settings, raw };
  });

  app.put("/api/farms/:farmId/settings", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const body = req.body as Record<string, unknown>;
    // Accept ownerPhone, supervisorPhone, senderId etc. - normalize
    const patch: Record<string, unknown> = {};
    if (body.ownerPhone) patch.ownerPhone = body.ownerPhone;
    if (body.supervisorPhone) patch.supervisorPhone = body.supervisorPhone;
    if (body.owner_phone) patch.ownerPhone = body.owner_phone;
    if (body.supervisor_phone) patch.supervisorPhone = body.supervisor_phone;
    // Pass through raw settings for rate etc.
    const updated = await updateFarmSettings(farmId, patch as never);
    return updated;
  });

  // Legacy simple: POST /api/farms/:farmId/owner-phone
  app.post("/api/farms/:farmId/owner-phone", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const body = req.body as { ownerPhone?: string; owner_phone?: string; supervisorPhone?: string; supervisor_phone?: string };
    const ownerPhone = body.ownerPhone ?? body.owner_phone;
    const supervisorPhone = body.supervisorPhone ?? body.supervisor_phone;
    if (!ownerPhone && !supervisorPhone) return reply.status(400).send({ error: "ownerPhone or supervisorPhone required" });
    const patch: Record<string, string> = {};
    if (ownerPhone) patch.ownerPhone = ownerPhone;
    if (supervisorPhone) patch.supervisorPhone = supervisorPhone;
    const updated = await updateFarmSettings(farmId, patch as never);
    return { ok: true, settings: updated };
  });
}
