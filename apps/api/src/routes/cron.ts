import type { FastifyInstance } from "fastify";
import { getDb } from "@tea-ledger/database";
import { sendFridayEstimate, sendSaturdayReminder } from "@tea-ledger/sms";

/**
 * Idempotent cron handlers — Africa/Nairobi, safe to restart
 * Vercel crons call these paths; manual POST also allowed with cron secret
 */

function isAuthorized(req: { headers: Record<string, unknown> }): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // open in preview/mock
  const hdr = (req.headers["authorization"] as string) ?? (req.headers["x-cron-secret"] as string);
  if (!hdr) return false;
  // Vercel sends Authorization: Bearer <CRON_SECRET>
  const token = hdr.replace(/^Bearer\s+/i, "");
  return token === secret;
}

export async function cronRoutes(app: FastifyInstance) {
  // Friday 17:00 EAT = 14:00 UTC -> Vercel cron: 0 14 * * 5
  app.get("/api/cron/friday-estimate", async (req, reply) => {
    if (!isAuthorized(req as never)) return reply.status(401).send({ error: "unauthorized" });
    const qs = req.query as { farm_id?: string; date?: string };
    const db = await getDb();
    const farms = qs.farm_id
      ? [{ farm_id: qs.farm_id }]
      : ((await db.query("SELECT farm_id FROM farms")).rows as Array<{ farm_id: string }>);
    const date = qs.date ?? new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
    // Week start Monday
    const weekStart = getWeekStartMonday(date);
    const results: unknown[] = [];
    for (const f of farms) {
      try {
        const r = await sendFridayEstimate({ farmId: f.farm_id, weekStart });
        results.push({ farmId: f.farm_id, ...r });
      } catch (e) {
        results.push({ farmId: f.farm_id, error: String(e) });
      }
    }
    return { ok: true, weekStart, results };
  });

  app.post("/api/cron/friday-estimate", async (req, reply) => {
    if (!isAuthorized(req as never)) return reply.status(401).send({ error: "unauthorized" });
    const body = (req.body ?? {}) as { farm_id?: string; date?: string };
    (req as unknown as { query: unknown }).query = body;
    return app.inject({ method: "GET", url: "/api/cron/friday-estimate", query: body as never }) as never;
  });

  // Saturday 14:30 EAT = 11:30 UTC -> Vercel cron: 30 11 * * 6
  app.get("/api/cron/saturday-reminder", async (req, reply) => {
    if (!isAuthorized(req as never)) return reply.status(401).send({ error: "unauthorized" });
    const qs = req.query as { farm_id?: string; date?: string };
    const db = await getDb();
    const farms = qs.farm_id
      ? [{ farm_id: qs.farm_id }]
      : ((await db.query("SELECT farm_id FROM farms")).rows as Array<{ farm_id: string }>);
    const date = qs.date ?? new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
    const weekStart = getWeekStartMonday(date);
    const results: unknown[] = [];
    for (const f of farms) {
      try {
        const r = await sendSaturdayReminder({ farmId: f.farm_id, weekStart });
        results.push({ farmId: f.farm_id, ...r });
      } catch (e) {
        results.push({ farmId: f.farm_id, error: String(e) });
      }
    }
    return { ok: true, weekStart, results };
  });

  app.post("/api/cron/saturday-reminder", async (req, reply) => {
    if (!isAuthorized(req as never)) return reply.status(401).send({ error: "unauthorized" });
    const body = (req.body ?? {}) as { farm_id?: string; date?: string };
    (req as unknown as { query: unknown }).query = body;
    return app.inject({ method: "GET", url: "/api/cron/saturday-reminder", query: body as never }) as never;
  });

  // Generic manual trigger for testing idempotency
  app.post("/api/cron/trigger", async (req, reply) => {
    const body = req.body as { job?: string; farm_id?: string; date?: string };
    if (!body?.job) return reply.status(400).send({ error: "job required: friday-estimate | saturday-reminder" });
    if (body.job === "friday-estimate") {
      return reply.redirect(`/api/cron/friday-estimate?farm_id=${body.farm_id ?? ""}&date=${body.date ?? ""}`);
    }
    if (body.job === "saturday-reminder") {
      return reply.redirect(`/api/cron/saturday-reminder?farm_id=${body.farm_id ?? ""}&date=${body.date ?? ""}`);
    }
    return reply.status(400).send({ error: "unknown job" });
  });
}

function getWeekStartMonday(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00+03:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find(p => p.type === "year")!.value;
  const m = parts.find(p => p.type === "month")!.value;
  const dayP = parts.find(p => p.type === "day")!.value;
  return `${y}-${m}-${dayP}`;
}
