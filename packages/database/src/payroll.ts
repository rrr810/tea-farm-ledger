import { getDb } from "./db.js";
import type { RateEntry, PluckEntry, WorkerInfo, Adjustment } from "@tea-ledger/core";

export async function getPayrollData(opts: {
  farmId: string;
  weekStart: string;
  weekEnd: string;
  dbClient?: Awaited<ReturnType<typeof getDb>>;
}): Promise<{
  workers: WorkerInfo[];
  plucksByWorker: Map<string, PluckEntry[]>;
  pluckingDays: Array<{ date: string; isPluckingDay: boolean }>;
  rates: RateEntry[];
  adjustmentsByWorker: Map<string, Adjustment[]>;
  priorAmountsByWorker: Map<string, number[]>;
  firstWeekByWorker: Map<string, boolean>;
  status: "open" | "locked" | "incomplete";
  lockedAt: string | null;
}> {
  const db = opts.dbClient ?? (await getDb());
  const { farmId, weekStart, weekEnd } = opts;

  // Workers
  const wRes = await db.query("SELECT worker_id, farm_id, full_name, phone_e164, verified FROM workers WHERE farm_id=$1", [farmId]);
  const workerRows = wRes.rows as Array<{
    worker_id: string;
    farm_id: string;
    full_name: string;
    phone_e164: string | null;
    verified: boolean;
  }>;

  const workers: WorkerInfo[] = [];
  for (const w of workerRows) {
    const epRes = await db.query("SELECT id, start_date, end_date FROM employment_periods WHERE worker_id=$1 ORDER BY start_date ASC", [w.worker_id]);
    const periods = (epRes.rows as Array<{ start_date: string; end_date: string | null }>).map((p) => ({
      startDate: typeof p.start_date === "string" ? p.start_date.slice(0, 10) : new Date(p.start_date).toISOString().slice(0, 10),
      endDate: p.end_date ? (typeof p.end_date === "string" ? p.end_date.slice(0, 10) : new Date(p.end_date).toISOString().slice(0, 10)) : null,
    }));
    workers.push({
      workerId: w.worker_id,
      fullName: w.full_name,
      phoneE164: w.phone_e164,
      verified: w.verified,
      employmentPeriods: periods,
    });
  }

  // Plucks: all pluck.logged in week
  const pluckRes = await db.query(
    `SELECT payload->>'worker_id' as worker_id, business_date, payload->>'kg_units' as kg_units, payload->>'present' as present
     FROM events WHERE farm_id=$1 AND business_date >= $2 AND business_date <= $3 AND event_type='pluck.logged'`,
    [farmId, weekStart, weekEnd],
  );
  const plucksByWorker = new Map<string, PluckEntry[]>();
  for (const r of pluckRes.rows as Array<{ worker_id: string; business_date: string; kg_units: string | null; present: string | null }>) {
    const wid = r.worker_id;
    if (!wid) continue;
    const bdate = typeof r.business_date === "string" ? r.business_date.slice(0, 10) : new Date(r.business_date).toISOString().slice(0, 10);
    const present = r.present !== "false"; // default true if missing
    const kgUnits = r.kg_units !== null ? Number(r.kg_units) : null;
    const entry: PluckEntry = { workerId: wid, businessDate: bdate, kgUnits: Number.isNaN(kgUnits as number) ? null : kgUnits, present };
    if (!plucksByWorker.has(wid)) plucksByWorker.set(wid, []);
    plucksByWorker.get(wid)!.push(entry);
  }

  // Plucking days for week
  const pdRes = await db.query("SELECT date, is_plucking_day FROM plucking_days WHERE farm_id=$1 AND date >= $2 AND date <= $3", [farmId, weekStart, weekEnd]);
  const pdMap = new Map<string, boolean>();
  for (const r of pdRes.rows as Array<{ date: string; is_plucking_day: boolean }>) {
    const d = typeof r.date === "string" ? r.date.slice(0, 10) : new Date(r.date).toISOString().slice(0, 10);
    pdMap.set(d, r.is_plucking_day);
  }
  const pluckingDays: Array<{ date: string; isPluckingDay: boolean }> = [];
  // Generate 6 days Mon-Sat, default true if not in table
  for (let i = 0; i < 6; i++) {
    const d = addDays(weekStart, i);
    pluckingDays.push({ date: d, isPluckingDay: pdMap.get(d) ?? true });
  }

  // Rates
  const ratesRes = await db.query("SELECT effective_from, rate_cents_per_kg FROM rates WHERE farm_id=$1 ORDER BY effective_from ASC", [farmId]);
  const rates: RateEntry[] = (ratesRes.rows as Array<{ effective_from: string; rate_cents_per_kg: number }>).map((r) => ({
    effectiveFrom: typeof r.effective_from === "string" ? r.effective_from.slice(0, 10) : new Date(r.effective_from).toISOString().slice(0, 10),
    rateCentsPerKg: r.rate_cents_per_kg,
  }));
  if (rates.length === 0) rates.push({ effectiveFrom: "2020-01-01", rateCentsPerKg: 900 });

  // Adjustments applied to this week
  const adjRes = await db.query("SELECT worker_id, kg_units, rate_cents_per_kg, reason FROM adjustments WHERE farm_id=$1 AND week_start=$2", [farmId, weekStart]);
  const adjustmentsByWorker = new Map<string, Adjustment[]>();
  for (const r of adjRes.rows as Array<{ worker_id: string; kg_units: number; rate_cents_per_kg: number; reason: string }>) {
    const list = adjustmentsByWorker.get(r.worker_id) ?? [];
    list.push({ workerId: r.worker_id, kgUnits: r.kg_units, rateCentsPerKg: r.rate_cents_per_kg, reason: r.reason });
    adjustmentsByWorker.set(r.worker_id, list);
  }

  // Prior amounts for anomaly (trailing 4 completed weeks before this week)
  const priorAmountsByWorker = new Map<string, number[]>();
  const firstWeekByWorker = new Map<string, boolean>();

  // Find all prior locked weeks before weekStart
  const priorWeeksRes = await db.query("SELECT week_start FROM pay_weeks WHERE farm_id=$1 AND week_start < $2 AND status='locked' ORDER BY week_start DESC LIMIT 20", [farmId, weekStart]);
  const priorWeeks = (priorWeeksRes.rows as Array<{ week_start: string }>).map((r) =>
    typeof r.week_start === "string" ? r.week_start.slice(0, 10) : new Date(r.week_start).toISOString().slice(0, 10),
  );

  // If no locked weeks before, consider isFirstWeek true for workers whose first employment start is in this week
  for (const w of workers) {
    const sortedPeriods = [...w.employmentPeriods].sort((a, b) => a.startDate.localeCompare(b.startDate));
    const firstStart = sortedPeriods[0]?.startDate;
    if (firstStart && firstStart >= weekStart && firstStart <= weekEnd) {
      firstWeekByWorker.set(w.workerId, true);
    } else if (priorWeeks.length === 0) {
      // If no prior locked weeks at all, every worker is first week? We check employment history: if they have only this period
      // We'll mark as first week if they have no prior payroll entries at all
      // Simpler: if no prior weeks exist, treat as limited history, but firstWeek flag only if their start is in week
      firstWeekByWorker.set(w.workerId, false);
    } else {
      firstWeekByWorker.set(w.workerId, false);
    }
  }

  // For each prior week, compute amount per worker from payroll_lines OR from events if not yet computed (fallback to events)
  // We use payroll_lines if exists, else we compute on fly from events for that week (but for M6 we will have payroll_lines after first compute)
  for (const pw of priorWeeks.slice(0, 4).reverse()) {
    // Try payroll_lines first
    const plRes = await db.query("SELECT worker_id, amount_cents FROM payroll_lines WHERE farm_id=$1 AND week_start=$2", [farmId, pw]);
    if ((plRes.rows as unknown[]).length > 0) {
      for (const r of plRes.rows as Array<{ worker_id: string; amount_cents: number }>) {
        const arr = priorAmountsByWorker.get(r.worker_id) ?? [];
        arr.push(Math.round(r.amount_cents / 100));
        priorAmountsByWorker.set(r.worker_id, arr);
      }
    } else {
      // Fallback: compute from events? We'll skip for now, just leave prior history limited
    }
  }

  // Status
  const pwRes = await db.query("SELECT status, locked_at FROM pay_weeks WHERE farm_id=$1 AND week_start=$2", [farmId, weekStart]);
  const pwRow = (pwRes.rows as Array<{ status: string; locked_at: string | null }>)[0];
  let status: "open" | "locked" | "incomplete" = "open";
  let lockedAt: string | null = null;
  if (pwRow) {
    status = pwRow.status as never;
    lockedAt = pwRow.locked_at ? new Date(pwRow.locked_at).toISOString() : null;
  } else {
    // Check if week has ended (Sat passed) but not locked => incomplete
    const weekEndDate = new Date(weekEnd + "T12:00:00+03:00");
    const now = new Date();
    // Use Africa/Nairobi today
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
    if (todayStr > weekEnd) status = "incomplete";
  }

  return {
    workers,
    plucksByWorker,
    pluckingDays,
    rates,
    adjustmentsByWorker,
    priorAmountsByWorker,
    firstWeekByWorker,
    status,
    lockedAt,
  };
}

export async function savePayrollLines(opts: {
  farmId: string;
  weekStart: string;
  weekEnd: string;
  lines: Array<{ workerId: string; kgUnits: number; amountCents: number; rateSnapshot: unknown; flags: string[] }>;
  dbClient?: Awaited<ReturnType<typeof getDb>>;
}) {
  const db = opts.dbClient ?? (await getDb());
  for (const l of opts.lines) {
    await db.query(
      `INSERT INTO payroll_lines (farm_id, week_start, worker_id, kg_units, rate_snapshot, amount_cents, flags)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (farm_id, week_start, worker_id) DO UPDATE SET kg_units=$4, rate_snapshot=$5::jsonb, amount_cents=$6, flags=$7`,
      [opts.farmId, opts.weekStart, l.workerId, l.kgUnits, JSON.stringify(l.rateSnapshot), l.amountCents, l.flags],
    );
  }
  await db.query(`INSERT INTO pay_weeks (farm_id, week_start, week_end, status, locked_at) VALUES ($1,$2,$3,'locked',NOW()) ON CONFLICT (farm_id, week_start) DO UPDATE SET status='locked', locked_at=NOW()`, [opts.farmId, opts.weekStart, opts.weekEnd]);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00+03:00");
  d.setDate(d.getDate() + days);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${day}`;
}

export async function createAdjustment(opts: {
  farmId: string;
  workerId: string;
  correctionWeekStart: string; // week where correction belongs (locked week)
  kgUnits: number;
  rateCentsPerKg: number;
  reason: string;
  dbClient?: Awaited<ReturnType<typeof getDb>>;
}) {
  const db = opts.dbClient ?? (await getDb());
  // Next week's weekStart = correctionWeekStart + 7 days
  const nextWeekStart = addDays(opts.correctionWeekStart, 7);
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO adjustments (id, farm_id, worker_id, week_start, kg_units, rate_cents_per_kg, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, opts.farmId, opts.workerId, nextWeekStart, opts.kgUnits, opts.rateCentsPerKg, opts.reason],
  );
  // Audit log
  await db.query(
    `INSERT INTO audit_log (farm_id, actor, action, target, detail) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [opts.farmId, "admin", "adjustment.created", opts.workerId, JSON.stringify({ correctionWeekStart: opts.correctionWeekStart, nextWeekStart, kgUnits: opts.kgUnits, reason: opts.reason })],
  );
  // Notify Owner SMS about correction (best-effort)
  try {
    const { getFarmSettings } = await import("@tea-ledger/sms");
    const settings = await (getFarmSettings as unknown as (id: string) => Promise<{ ownerPhone?: string }>)(opts.farmId);
    if (settings.ownerPhone) {
      const { getSmsAdapter } = await import("@tea-ledger/sms");
      const adapter = getSmsAdapter();
      await adapter.send({
        to: settings.ownerPhone,
        body: `TEA correction applied: ${opts.kgUnits / 10}kg for ${opts.workerId.slice(0, 6)} moved to next week ${nextWeekStart}. Reason: ${opts.reason}`,
        farmId: opts.farmId,
        type: "correction-notify",
      });
      const { getDb: gdb } = await import("./db.js");
      const dbs = await gdb();
      await dbs.query(
        `INSERT INTO sms_messages (id, farm_id, type, to_phone, body, segments, status, provider_id, job_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [crypto.randomUUID(), opts.farmId, "correction-notify", settings.ownerPhone, `TEA correction applied: ${opts.kgUnits / 10}kg for ${opts.workerId.slice(0, 6)} moved to next week ${nextWeekStart}. Reason: ${opts.reason}`, 1, "queued", "mock-correction", `correction:${opts.farmId}:${nextWeekStart}:${opts.workerId}:${id}`],
      );
    }
  } catch {}
  return { id, nextWeekStart };
}
