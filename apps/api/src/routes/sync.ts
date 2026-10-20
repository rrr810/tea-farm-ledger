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

    // M5: side effects — plucking_days + SMS (idempotent, mock default)
    // Do not block sync response on SMS failures
    for (const ev of events) {
      try {
        if (ev.event_type === "day.plucking_set") {
          const payload = ev.payload as { date?: string; is_plucking_day?: boolean; reason?: string };
          const date = (payload.date as string) ?? ev.business_date;
          const isPlucking = payload.is_plucking_day ?? false;
          const reason = (payload.reason as string) ?? null;
          await db.query(
            `INSERT INTO plucking_days (farm_id, date, is_plucking_day, reason, confirmed, confirmed_at)
             VALUES ($1,$2,$3,$4,true,NOW())
             ON CONFLICT (farm_id, date) DO UPDATE SET is_plucking_day=$3, reason=$4, confirmed=true, confirmed_at=NOW()`,
            [ev.farm_id, date, isPlucking, reason]
          );
          if (!isPlucking) {
            const { sendNoPluckingSms } = await import("@tea-ledger/sms");
            await sendNoPluckingSms({ farmId: ev.farm_id, date, reason: reason ?? undefined });
          }
        }
        if (ev.event_type === "day.confirmed") {
          const payload = ev.payload as { date?: string };
          const date = (payload.date as string) ?? ev.business_date;
          await db.query(
            `INSERT INTO plucking_days (farm_id, date, is_plucking_day, confirmed, confirmed_at)
             VALUES ($1,$2,true,true,NOW())
             ON CONFLICT (farm_id, date) DO UPDATE SET confirmed=true, confirmed_at=NOW()`,
            [ev.farm_id, date]
          );
          const { sendDailyOwnerSms } = await import("@tea-ledger/sms");
          await sendDailyOwnerSms({ farmId: ev.farm_id, date });
        }
        if (ev.event_type === "week.submitted") {
          const { sendWeeklyReceipts } = await import("@tea-ledger/sms");
          // weekStart is Monday of business_date
          const { getWeekStartMonday } = await import("@tea-ledger/core");
          const weekStart = getWeekStartMonday(ev.business_date);
          await sendWeeklyReceipts({ farmId: ev.farm_id, weekStart });
        }
      } catch (e) {
        // Log but don't fail sync — SMS is best-effort, idempotent retry via cron
        app.log.warn({ err: e, event_id: ev.event_id }, "sms side-effect failed");
      }
    }

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
