import type { FastifyInstance } from "fastify";
import { getDb } from "@tea-ledger/database";
import { getPayrollData, createAdjustment, savePayrollLines } from "@tea-ledger/database";
import { computePayrollSheet, payrollToCsv, payrollToPrintableHtml } from "@tea-ledger/core";
import { getWeekStartMonday, getWeekEndSaturday } from "@tea-ledger/core";

export async function payrollRoutes(app: FastifyInstance) {
  // GET /api/farms/:farmId/payroll/:weekStart?format=csv|html|json (query format overrides Accept)
  app.get("/api/farms/:farmId/payroll/:weekStart", async (req, reply) => {
    const { farmId, weekStart } = req.params as { farmId: string; weekStart: string };
    const qs = req.query as { format?: string; factory_total?: string };
    const format = qs.format ?? (req.headers.accept?.includes("text/csv") ? "csv" : req.headers.accept?.includes("text/html") ? "html" : "json");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return reply.status(400).send({ error: "weekStart must be YYYY-MM-DD (Monday)" });

    const weekEnd = getWeekEndSaturday(weekStart);
    const db = await getDb();

    const data = await getPayrollData({ farmId, weekStart, weekEnd, dbClient: db as never });

    const sheet = computePayrollSheet({
      farmId,
      weekStart,
      weekEnd,
      status: data.status,
      lockedAt: data.lockedAt,
      workers: data.workers,
      plucksByWorker: data.plucksByWorker,
      pluckingDays: data.pluckingDays,
      rates: data.rates,
      adjustmentsByWorker: data.adjustmentsByWorker,
      priorAmountsByWorker: data.priorAmountsByWorker,
      firstWeekByWorker: data.firstWeekByWorker,
    });

    // Factory tolerance flag if factory_total query provided
    if (qs.factory_total) {
      const factoryKgUnits = Math.round(Number(qs.factory_total) * 10);
      if (!Number.isNaN(factoryKgUnits) && factoryKgUnits > 0) {
        const totalKgUnits = sheet.totals.totalKgUnits;
        if (totalKgUnits > 0) {
          const diff = Math.abs(factoryKgUnits - totalKgUnits) / factoryKgUnits;
          if (diff > 0.05) sheet.flags.toleranceExceeded = true;
        }
      }
    }

    if (format === "csv") {
      const csv = payrollToCsv(sheet);
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="payroll-${farmId}-${weekStart}.csv"`);
      return reply.send(csv);
    }
    if (format === "html") {
      const farmRes = await db.query("SELECT name FROM farms WHERE farm_id=$1", [farmId]);
      const farmName = (farmRes.rows as Array<{ name: string }>)[0]?.name ?? farmId.slice(0, 8);
      const html = payrollToPrintableHtml(sheet, farmName);
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply.send(html);
    }

    // Also persist payroll_lines if locked? Compute but don't overwrite locked? We compute on fly.
    // If status is locked, ensure payroll_lines exist for history/anomaly. Save if not exists.
    if (sheet.status === "locked") {
      try {
        await savePayrollLines({
          farmId,
          weekStart,
          weekEnd,
          lines: sheet.lines.map((l) => ({
            workerId: l.workerId,
            kgUnits: l.totalKgUnits,
            amountCents: l.amountCents,
            rateSnapshot: { rateCentsPerKg: l.rateCentsPerKg, bands: l.rateBands },
            flags: l.flags,
          })),
          dbClient: db as never,
        });
      } catch {}
    }

    return { sheet, farm_id: farmId, week_start: weekStart, week_end: weekEnd };
  });

  // GET /api/farms/:farmId/payroll - list pay weeks
  app.get("/api/farms/:farmId/payroll", async (req) => {
    const { farmId } = req.params as { farmId: string };
    const db = await getDb();
    const res = await db.query("SELECT week_start, week_end, status, locked_at FROM pay_weeks WHERE farm_id=$1 ORDER BY week_start DESC", [farmId]);
    const weeks = (res.rows as Array<{ week_start: string; week_end: string; status: string; locked_at: string | null }>).map((r) => ({
      week_start: typeof r.week_start === "string" ? r.week_start.slice(0, 10) : new Date(r.week_start).toISOString().slice(0, 10),
      week_end: typeof r.week_end === "string" ? r.week_end.slice(0, 10) : new Date(r.week_end).toISOString().slice(0, 10),
      status: r.status,
      locked_at: r.locked_at,
    }));
    return { weeks };
  });

  // POST /api/farms/:farmId/adjustments - Admin creates adjustment for next week (correction)
  app.post("/api/farms/:farmId/adjustments", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const body = req.body as {
      worker_id?: string;
      workerId?: string;
      correction_week_start?: string;
      correctionWeekStart?: string;
      kg?: number;
      kg_units?: number;
      rate_cents_per_kg?: number;
      rateCentsPerKg?: number;
      reason?: string;
    };
    const workerId = body.worker_id ?? body.workerId;
    const correctionWeekStart = body.correction_week_start ?? body.correctionWeekStart;
    const kg = body.kg ?? (body.kg_units !== undefined ? body.kg_units / 10 : undefined);
    const kgUnits = body.kg_units ?? (kg !== undefined ? Math.round(kg * 10) : undefined);
    const rateCentsPerKg = body.rate_cents_per_kg ?? body.rateCentsPerKg ?? 900;
    const reason = body.reason;

    if (!workerId || !correctionWeekStart || kgUnits === undefined || !reason) {
      return reply.status(400).send({ error: "worker_id, correction_week_start, kg_units (or kg), reason required" });
    }
    // Verify correction week is locked (server authoritative lock)
    const db = await getDb();
    const pwRes = await db.query("SELECT status FROM pay_weeks WHERE farm_id=$1 AND week_start=$2", [farmId, correctionWeekStart]);
    const isLocked = (pwRes.rows as Array<{ status: string }>)[0]?.status === "locked";
    if (!isLocked) {
      return reply.status(409).send({ error: "correction_week must be locked before creating adjustment — submit Saturday first" });
    }

    try {
      const res = await createAdjustment({
        farmId,
        workerId,
        correctionWeekStart,
        kgUnits: Number(kgUnits),
        rateCentsPerKg: Number(rateCentsPerKg),
        reason: String(reason),
        dbClient: db as never,
      });
      return { ok: true, adjustment_id: res.id, next_week_start: res.nextWeekStart };
    } catch (e) {
      return reply.status(500).send({ error: String(e) });
    }
  });

  // GET /api/farms/:farmId/adjustments?week_start=
  app.get("/api/farms/:farmId/adjustments", async (req) => {
    const { farmId } = req.params as { farmId: string };
    const qs = req.query as { week_start?: string; weekStart?: string };
    const weekStart = qs.week_start ?? qs.weekStart;
    const db = await getDb();
    let res;
    if (weekStart) {
      res = await db.query("SELECT * FROM adjustments WHERE farm_id=$1 AND week_start=$2 ORDER BY created_at ASC", [farmId, weekStart]);
    } else {
      res = await db.query("SELECT * FROM adjustments WHERE farm_id=$1 ORDER BY week_start DESC, created_at ASC", [farmId]);
    }
    return { adjustments: res.rows };
  });

  // GET /api/farms/:farmId/correction-requests - alias for /api/farms/:farmId/corrections with more detail
  app.get("/api/farms/:farmId/correction-requests", async (req) => {
    const { farmId } = req.params as { farmId: string };
    const db = await getDb();
    const res = await db.query(
      "SELECT event_id, business_date, payload, correction_flag, conflict_flag, client_timestamp, server_received_at FROM events WHERE farm_id=$1 AND correction_flag=true ORDER BY business_date ASC",
      [farmId],
    );
    return { corrections: res.rows, count: res.rows.length };
  });

  // POST /api/farms/:farmId/rates - set rate effective_from
  app.post("/api/farms/:farmId/rates", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const body = req.body as { effective_from?: string; effectiveFrom?: string; rate_cents_per_kg?: number; rateCentsPerKg?: number; rate?: number };
    const effectiveFrom = body.effective_from ?? body.effectiveFrom;
    let rateCentsPerKg = body.rate_cents_per_kg ?? body.rateCentsPerKg;
    if (rateCentsPerKg === undefined && body.rate !== undefined) rateCentsPerKg = Math.round(Number(body.rate) * 100);
    if (!effectiveFrom || rateCentsPerKg === undefined) return reply.status(400).send({ error: "effective_from and rate_cents_per_kg (or rate KES) required" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return reply.status(400).send({ error: "effective_from must be YYYY-MM-DD" });
    const db = await getDb();
    await db.query("INSERT INTO rates (farm_id, effective_from, rate_cents_per_kg) VALUES ($1,$2,$3) ON CONFLICT (farm_id, effective_from) DO UPDATE SET rate_cents_per_kg=$3", [farmId, effectiveFrom, Number(rateCentsPerKg)]);
    const author = (req.headers["x-author"] as string) ?? "admin";
    // Log event for audit
    const eventId = crypto.randomUUID();
    const businessDate = effectiveFrom;
    await db.query(
      `INSERT INTO events (event_id, farm_id, device_id, author, event_type, payload, business_date, client_timestamp)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,NOW())`,
      [eventId, farmId, null, author, "rate.set", JSON.stringify({ effective_from: effectiveFrom, rate_cents_per_kg: Number(rateCentsPerKg) }), businessDate],
    );
    return { ok: true, effective_from: effectiveFrom, rate_cents_per_kg: Number(rateCentsPerKg) };
  });

  app.get("/api/farms/:farmId/rates", async (req) => {
    const { farmId } = req.params as { farmId: string };
    const db = await getDb();
    const res = await db.query("SELECT effective_from, rate_cents_per_kg FROM rates WHERE farm_id=$1 ORDER BY effective_from ASC", [farmId]);
    return {
      rates: (res.rows as Array<{ effective_from: string; rate_cents_per_kg: number }>).map((r) => ({
        effective_from: typeof r.effective_from === "string" ? r.effective_from.slice(0, 10) : new Date(r.effective_from).toISOString().slice(0, 10),
        rate_cents_per_kg: r.rate_cents_per_kg,
      })),
    };
  });
}
