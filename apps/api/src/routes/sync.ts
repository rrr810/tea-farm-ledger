import type { FastifyInstance } from "fastify";
import { getDb } from "@tea-ledger/database";
import { pushEvents, pullEvents } from "@tea-ledger/database";
import { requireAdminForFarm } from "../admin-auth.js";
import { isUuid, requireFarmDevice } from "../device-auth.js";

export async function syncRoutes(app: FastifyInstance) {
  app.post("/api/sync/push", async (req, reply) => {
    const body = req.body as { events?: unknown[] };
    if (!Array.isArray(body?.events) || body.events.length === 0) {
      return reply.status(400).send({ error: "a non-empty events array is required" });
    }
    const events = body.events as import("@tea-ledger/core").LedgerEvent[];
    const farmId = events[0]?.farm_id;
    const deviceId = events[0]?.device_id;
    if (!isUuid(farmId) || !isUuid(deviceId)) {
      return reply.status(400).send({ error: "events must include valid farm_id and device_id values" });
    }
    for (const ev of events) {
      if (
        !ev.event_id ||
        !isUuid(ev.farm_id) ||
        !isUuid(ev.device_id) ||
        !ev.event_type ||
        !ev.business_date
      ) {
        return reply.status(400).send({ error: "invalid device-bound event", event_id: ev.event_id });
      }
      if (ev.farm_id !== farmId || ev.device_id !== deviceId) {
        return reply.status(400).send({ error: "a sync batch may contain events from only one enrolled device and farm" });
      }
    }

    const device = await requireFarmDevice(req, reply, farmId);
    if (!device) return;
    if (device.deviceId !== deviceId) {
      return reply.status(403).send({ error: "event device does not match the authenticated field device" });
    }

    const db = await getDb();
    const result = await pushEvents(events, db as Awaited<ReturnType<typeof getDb>>);

    // M5: side effects — plucking_days + SMS (idempotent, mock default).
    // A new, authenticated field-device event is required before this code can
    // run; replayed/foreign events never produce a new SMS side effect.
    const acceptedEventIds = new Set(result.acceptedEventIds);
    for (const ev of events) {
      try {
        if ((ev.event_type === "day.plucking_set" || ev.event_type === "day.confirmed") && !acceptedEventIds.has(ev.event_id)) continue;
        // A late/conflicted completed-day event is retained as history but must
        // never cause a fresh financial SMS for an already-locked record.
        if (ev.event_type === "day.plucking_set" || ev.event_type === "day.confirmed") {
          const stored = await db.query(
            "SELECT correction_flag, conflict_flag FROM events WHERE event_id=$1",
            [ev.event_id],
          );
          const flags = (stored.rows as Array<{ correction_flag?: boolean; conflict_flag?: boolean }>)[0];
          if (flags?.correction_flag || flags?.conflict_flag) continue;
        }
        if (ev.event_type === "day.plucking_set") {
          const payload = ev.payload as { date?: string; is_plucking_day?: boolean; reason?: string };
          const date = (payload.date as string) ?? ev.business_date;
          const isPlucking = payload.is_plucking_day ?? false;
          const reason = (payload.reason as string) ?? null;
          await db.query(
            `INSERT INTO plucking_days (farm_id, date, is_plucking_day, reason, confirmed, confirmed_at)
             VALUES ($1,$2,$3,$4,true,NOW())
             ON CONFLICT (farm_id, date) DO UPDATE SET is_plucking_day=$3, reason=$4, confirmed=true, confirmed_at=NOW()`,
            [ev.farm_id, date, isPlucking, reason],
          );
          if (!isPlucking) {
            const { isLiveDailySmsEnabledForFarm, sendLiveNoPluckingSms, sendNoPluckingSms } = await import("@tea-ledger/sms");
            if (isLiveDailySmsEnabledForFarm(ev.farm_id)) {
              await sendLiveNoPluckingSms({ farmId: ev.farm_id, date, reason: reason ?? undefined });
            } else {
              await sendNoPluckingSms({ farmId: ev.farm_id, date, reason: reason ?? undefined });
            }
          }
        }
        if (ev.event_type === "day.confirmed") {
          const payload = ev.payload as { date?: string };
          const date = (payload.date as string) ?? ev.business_date;
          await db.query(
            `INSERT INTO plucking_days (farm_id, date, is_plucking_day, confirmed, confirmed_at)
             VALUES ($1,$2,true,true,NOW())
             ON CONFLICT (farm_id, date) DO UPDATE SET confirmed=true, confirmed_at=NOW()`,
            [ev.farm_id, date],
          );
          const { isLiveDailySmsEnabledForFarm, sendLiveDailySms, sendDailyOwnerSms } = await import("@tea-ledger/sms");
          if (isLiveDailySmsEnabledForFarm(ev.farm_id)) {
            await sendLiveDailySms({ farmId: ev.farm_id, date });
          } else {
            await sendDailyOwnerSms({ farmId: ev.farm_id, date });
          }
        }
        if (ev.event_type === "week.submitted" && acceptedEventIds.has(ev.event_id)) {
          const { getWeekStartMonday } = await import("@tea-ledger/core");
          const weekStart = getWeekStartMonday(ev.business_date);
          const { isLiveDailySmsEnabledForFarm, sendLiveWeeklyOwnerSms, sendWeeklyReceipts } = await import("@tea-ledger/sms");
          // The approved live rollout is owner-only at FINAL: a detailed weekly
          // payroll report is sent after the server has locked the week. The
          // older worker-receipt path remains available only outside that live
          // rollout and can never double-message the live farm.
          if (isLiveDailySmsEnabledForFarm(ev.farm_id)) {
            await sendLiveWeeklyOwnerSms({ farmId: ev.farm_id, weekStart });
          } else {
            await sendWeeklyReceipts({ farmId: ev.farm_id, weekStart });
          }
        }
      } catch (e) {
        // Do not block the authenticated ledger sync on a best-effort provider
        // action. An idempotency record remains the only delivery audit trail.
        app.log.warn({ err: e, event_id: ev.event_id }, "sms side-effect failed");
      }
    }

    return result;
  });

  app.get("/api/sync/pull", async (req, reply) => {
    const qs = req.query as { farm_id?: string; since?: string; limit?: string };
    if (!qs.farm_id) return reply.status(400).send({ error: "farm_id required" });
    const device = await requireFarmDevice(req, reply, qs.farm_id);
    if (!device) return;
    const since = qs.since ? Number(qs.since) : null;
    const limit = qs.limit ? Math.min(Number(qs.limit), 500) : 100;
    const db = await getDb();
    const result = await pullEvents(since, qs.farm_id, limit, db as Awaited<ReturnType<typeof getDb>>);
    return result;
  });

  // Conflict/correction ledgers contain operational history and are presented
  // only in the owner console.
  app.get("/api/farms/:farmId/conflicts", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const admin = await requireAdminForFarm(req, reply, farmId);
    if (!admin) return;
    const db = await getDb();
    const res = await db.query("SELECT * FROM events WHERE farm_id = $1 AND conflict_flag = true ORDER BY seq DESC", [farmId]);
    return { conflicts: res.rows };
  });

  app.get("/api/farms/:farmId/corrections", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const admin = await requireAdminForFarm(req, reply, farmId);
    if (!admin) return;
    const db = await getDb();
    const res = await db.query("SELECT * FROM events WHERE farm_id = $1 AND correction_flag = true ORDER BY seq DESC", [farmId]);
    return { corrections: res.rows };
  });
}
