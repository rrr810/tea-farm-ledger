import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@tea-ledger/database";
import {
  applyDeliveryReport,
  applyMobileSasaDeliveryReport,
  getFarmSettings,
  getSmsStats,
  listSmsLog,
  mobileSasaDeliveryStatus,
  refreshLiveDailyDeliveryReports,
  updateFarmSettings,
} from "@tea-ledger/sms";

function sameWebhookSecret(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

export async function smsRoutes(app: FastifyInstance) {
  // POST /api/sms/delivery-report — Telnyx delivery-status webhook.
  // Point the Messaging Profile's Outbound webhook here. Terminal status rides on
  // data.to[].status; event_type (message.sent/delivered/finalized) is the fallback.
  // NOTE (documented): Telnyx ed25519 signature verification is not enforced yet —
  // worst case a spoofed report mislabels a status in the log; add signature checks
  // before multi-farm scale. We always ACK 200 so Telnyx never retry-storms.
  app.post("/api/sms/delivery-report", async (req, reply) => {
    try {
      const body = req.body as {
        data?: { id?: string; event_type?: string; to?: Array<{ status?: string }> };
      };
      const providerId = body?.data?.id;
      if (!providerId) return reply.status(400).send({ ok: false, error: "missing message id" });
      const toStatus = body?.data?.to?.[0]?.status ?? "";
      const event = body?.data?.event_type ?? "";
      let status: "queued" | "sent" | "delivered" | "failed" | null = null;
      if (toStatus === "delivered" || event === "message.delivered") status = "delivered";
      else if (toStatus === "failed" || toStatus === "undelivered") status = "failed";
      else if (toStatus === "sent" || event === "message.sent") status = "sent";
      else if (toStatus === "queued") status = "queued";
      else if (event === "message.finalized") status = "failed"; // terminal but no to-status — surface loudly
      if (status) await applyDeliveryReport(providerId, status);
      return { ok: true, updated: Boolean(status) };
    } catch (e) {
      console.error("[sms:delivery-report]", e instanceof Error ? e.message : e);
      return { ok: true, updated: false };
    }
  });

  // POST /api/farms/:farmId/sms/refresh-delivery
  // Runs a bounded, read-only Mobile Sasa DLR reconciliation for messages that
  // have already been accepted by the provider. It contains no send/retry path.
  app.post("/api/farms/:farmId/sms/refresh-delivery", async (req) => {
    const { farmId } = req.params as { farmId: string };
    return refreshLiveDailyDeliveryReports({ farmId });
  });

  // POST /api/sms/mobilesasa-delivery-report
  // This endpoint is intentionally fail-closed until a distinct webhook secret
  // is supplied through deployment environment configuration. Mobile Sasa sends
  // the message reference plus our trackingId; either can reconcile the row.
  app.post("/api/sms/mobilesasa-delivery-report", async (req, reply) => {
    const webhookSecret = process.env.MOBILESASA_WEBHOOK_SECRET?.trim();
    if (!webhookSecret) {
      return reply.status(404).send({ ok: false, error: "Mobile Sasa callback is not configured" });
    }
    const header = req.headers["x-mobilesasa-secret"];
    const receivedSecret = Array.isArray(header) ? header[0] : header;
    if (!sameWebhookSecret(receivedSecret, webhookSecret)) {
      return reply.status(401).send({ ok: false, error: "invalid callback secret" });
    }

    const body = req.body as {
      status?: string;
      deliveryStatus?: string;
      reference?: string;
      trackingId?: string;
      dlr?: { tracking_id?: string; description?: string };
    };
    const providerId = body?.reference;
    const trackingId = body?.trackingId ?? body?.dlr?.tracking_id;
    if (!providerId && !trackingId) {
      return reply.status(400).send({ ok: false, error: "missing Mobile Sasa reference/trackingId" });
    }

    const status = mobileSasaDeliveryStatus(body?.status ?? body?.deliveryStatus ?? body?.dlr?.description);
    const updated = await applyMobileSasaDeliveryReport({ providerId, trackingId, status });
    return { ok: true, updated, status };
  });

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
    if (body.ownerName) patch.ownerName = body.ownerName;
    if (body.supervisorPhone) patch.supervisorPhone = body.supervisorPhone;
    if (body.owner_phone) patch.ownerPhone = body.owner_phone;
    if (body.owner_name) patch.ownerName = body.owner_name;
    if (body.supervisor_phone) patch.supervisorPhone = body.supervisor_phone;
    // Pass through raw settings for rate etc.
    const updated = await updateFarmSettings(farmId, patch as never);
    return updated;
  });

  // Legacy simple: POST /api/farms/:farmId/owner-phone
  app.post("/api/farms/:farmId/owner-phone", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const body = req.body as {
      ownerPhone?: string;
      owner_phone?: string;
      ownerName?: string;
      owner_name?: string;
      supervisorPhone?: string;
      supervisor_phone?: string;
    };
    const ownerPhone = body.ownerPhone ?? body.owner_phone;
    const ownerName = body.ownerName ?? body.owner_name;
    const supervisorPhone = body.supervisorPhone ?? body.supervisor_phone;
    if (!ownerPhone && !ownerName && !supervisorPhone)
      return reply.status(400).send({ error: "ownerPhone, ownerName, or supervisorPhone required" });
    const patch: Record<string, string> = {};
    if (ownerPhone) patch.ownerPhone = ownerPhone;
    if (ownerName) patch.ownerName = ownerName;
    if (supervisorPhone) patch.supervisorPhone = supervisorPhone;
    const updated = await updateFarmSettings(farmId, patch as never);
    return { ok: true, settings: updated };
  });
}
