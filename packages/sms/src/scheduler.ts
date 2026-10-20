import { getDb } from "@tea-ledger/database";
import { buildDailySms, buildNoPluckingSms, buildFridayEstimateSms, buildSupervisorReminderSms, buildWeeklyReceiptSms } from "@tea-ledger/core";
import { getSmsAdapter } from "./index.js";
import { randomUUID } from "node:crypto";

/**
 * M5 SMS Scheduler — idempotent, Africa/Nairobi cron, mock default
 * All jobs use job_key = farmId:date:type[:extra] UNIQUE in sms_messages
 * Restart never double-sends.
 */

export type FarmSettings = {
  ownerPhone?: string;
  supervisorPhone?: string;
  fridayEstimateTime?: string; // default 17:00
};

export async function getFarmSettings(farmId: string): Promise<FarmSettings> {
  const db = await getDb();
  const res = await db.query("SELECT settings FROM farm_settings WHERE farm_id=$1", [farmId]);
  const row = (res.rows as Array<{ settings: FarmSettings }>)[0];
  return row?.settings ?? {};
}

export async function updateFarmSettings(farmId: string, patch: Partial<FarmSettings>) {
  const db = await getDb();
  const existing = await getFarmSettings(farmId);
  const merged = { ...existing, ...patch };
  await db.query(
    `INSERT INTO farm_settings (farm_id, settings) VALUES ($1,$2::jsonb)
     ON CONFLICT (farm_id) DO UPDATE SET settings=$2::jsonb, updated_at=NOW()`,
    [farmId, JSON.stringify(merged)]
  );
  return merged;
}

async function insertSmsIfNotExists(opts: {
  farmId: string;
  jobKey: string;
  type: string;
  to: string;
  body: string;
  segments: number;
}): Promise<{ inserted: boolean; id: string }> {
  const db = await getDb();
  // idempotent check
  const existing = await db.query("SELECT id FROM sms_messages WHERE job_key=$1", [opts.jobKey]);
  if ((existing.rows as unknown[]).length > 0) {
    const row = (existing.rows as Array<{ id: string }>)[0];
    return { inserted: false, id: row.id };
  }
  const id = randomUUID();
  const adapter = getSmsAdapter();
  const result = await adapter.send({ to: opts.to, body: opts.body, farmId: opts.farmId, type: opts.type });
  await db.query(
    `INSERT INTO sms_messages (id, farm_id, type, to_phone, body, segments, status, provider_id, job_key, cost_estimate_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, opts.farmId, opts.type, opts.to, opts.body, result.segments, result.status, result.providerId ?? null, opts.jobKey, result.costEstimateCents ?? null]
  );
  // also track in sms_jobs for crons
  try {
    await db.query(
      `INSERT INTO sms_jobs (job_key, farm_id, type, scheduled_for, executed_at, status) VALUES ($1,$2,$3,NOW(),NOW(),'sent') ON CONFLICT (job_key) DO NOTHING`,
      [opts.jobKey, opts.farmId, opts.type]
    );
  } catch {}
  return { inserted: true, id };
}

// Daily Owner summary — triggered when day.confirmed arrives
export async function sendDailyOwnerSms(opts: { farmId: string; date: string }) {
  const { farmId, date } = opts;
  const settings = await getFarmSettings(farmId);
  const to = settings.ownerPhone;
  if (!to) return { skipped: true, reason: "ownerPhone not set" } as const;

  const db = await getDb();
  // Gather plucks for date
  const plucks = await db.query(
    `SELECT payload->>'worker_id' as worker_id, payload->>'kg_units' as kg_units, payload->>'present' as present
     FROM events WHERE farm_id=$1 AND business_date=$2 AND event_type='pluck.logged'`,
    [farmId, date]
  );
  const dayInfo = await db.query(`SELECT payload FROM events WHERE farm_id=$1 AND business_date=$2 AND event_type='day.plucking_set' LIMIT 1`, [farmId, date]);
  const isNoPlucking = (dayInfo.rows as Array<{ payload: { is_plucking_day?: boolean } }>)[0]?.payload?.is_plucking_day === false;

  if (isNoPlucking) {
    // Don't send daily summary, send no-plucking instead (handled separately)
    return { skipped: true, reason: "no plucking day" } as const;
  }

  // Resolve worker names + kg
  const lines: Array<{ name: string; kgUnits: number }> = [];
  let totalKgUnits = 0;
  for (const r of plucks.rows as Array<{ worker_id: string; kg_units: string; present: string }>) {
    if (r.present === "false" || r.kg_units == null) continue;
    const kgUnits = Number(r.kg_units);
    if (Number.isNaN(kgUnits)) continue;
    const w = await db.query("SELECT full_name FROM workers WHERE worker_id=$1", [r.worker_id]);
    const name = (w.rows as Array<{ full_name: string }>)[0]?.full_name ?? r.worker_id.slice(0, 6);
    lines.push({ name, kgUnits });
    totalKgUnits += kgUnits;
  }
  if (lines.length === 0) return { skipped: true, reason: "no pickers" } as const;

  const dateLabel = new Date(date + "T12:00:00+03:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "Africa/Nairobi" }).replace(",", "");
  // Rate: get effective rate for date
  const rateRes = await db.query("SELECT rate_cents_per_kg FROM rates WHERE farm_id=$1 AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1", [farmId, date]);
  const rateCentsPerKg = (rateRes.rows as Array<{ rate_cents_per_kg: number }>)[0]?.rate_cents_per_kg ?? 900;
  const totalPay = Math.round((totalKgUnits * rateCentsPerKg) / 10 / 100); // rough est, server should compute weighted correctly

  const { body, segments } = buildDailySms({
    dateLabel,
    totalKgUnits,
    pickerCount: lines.length,
    lines,
    rateCentsPerKg,
    totalPayEstimateKes: totalPay,
  });

  const jobKey = `${farmId}:${date}:daily-owner`;
  const res = await insertSmsIfNotExists({ farmId, jobKey, type: "daily-owner", to, body, segments });
  return { sent: res.inserted, jobKey, segments, to, body, skipped: false as const };
}

export async function sendNoPluckingSms(opts: { farmId: string; date: string; reason?: string }) {
  const { farmId, date, reason } = opts;
  const settings = await getFarmSettings(farmId);
  const to = settings.ownerPhone;
  if (!to) return { skipped: true, reason: "ownerPhone not set" } as const;
  const dateLabel = new Date(date + "T12:00:00+03:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "Africa/Nairobi" }).replace(",", "");
  const { body, segments } = buildNoPluckingSms({ dateLabel, reason: reason ?? "not specified" });
  const jobKey = `${farmId}:${date}:no-plucking`;
  const res = await insertSmsIfNotExists({ farmId, jobKey, type: "no-plucking", to, body, segments });
  return { sent: res.inserted, jobKey, segments, to, body, skipped: false as const };
}

export async function sendFridayEstimate(opts: { farmId: string; weekStart: string }) {
  const { farmId, weekStart } = opts;
  const settings = await getFarmSettings(farmId);
  const to = settings.ownerPhone ?? settings.supervisorPhone;
  if (!to) return { skipped: true, reason: "no owner/supervisor phone" } as const;

  const db = await getDb();
  // Mon-Fri of week
  const totalRes = await db.query(
    `SELECT SUM((payload->>'kg_units')::int) as sum FROM events WHERE farm_id=$1 AND business_date >= $2 AND business_date <= $3 AND event_type='pluck.logged'`,
    [farmId, weekStart, addDays(weekStart, 4)]
  );
  const sum = (totalRes.rows as Array<{ sum: string | null }>)[0]?.sum;
  const totalKgUnits = sum ? Number(sum) : 0;
  if (totalKgUnits === 0) return { skipped: true, reason: "no kg Mon-Fri" } as const;

  // Rate: use latest
  const rateRes = await db.query("SELECT rate_cents_per_kg FROM rates WHERE farm_id=$1 ORDER BY effective_from DESC LIMIT 1", [farmId]);
  const rateCentsPerKg = (rateRes.rows as Array<{ rate_cents_per_kg: number }>)[0]?.rate_cents_per_kg ?? 900;
  const estPayKes = Math.round((totalKgUnits * rateCentsPerKg) / 10 / 100);

  const dateLabel = `Wk ${weekStart}`;
  const { body, segments } = buildFridayEstimateSms({ dateLabel, totalKgUnits, estPayKes });
  const jobKey = `${farmId}:${weekStart}:friday-estimate`;
  const res = await insertSmsIfNotExists({ farmId, jobKey, type: "friday-estimate", to, body, segments });
  return { sent: res.inserted, jobKey, segments, to, body, skipped: false as const };
}

export async function sendSaturdayReminder(opts: { farmId: string; weekStart: string }) {
  const { farmId, weekStart } = opts;
  const settings = await getFarmSettings(farmId);
  const to = settings.supervisorPhone;
  if (!to) return { skipped: true, reason: "supervisorPhone not set" } as const;

  const db = await getDb();
  const weekEnd = addDays(weekStart, 5); // Sat
  const exists = await db.query(`SELECT 1 FROM events WHERE farm_id=$1 AND business_date=$2 AND event_type='week.submitted' LIMIT 1`, [farmId, weekEnd]);
  if ((exists.rows as unknown[]).length > 0) return { skipped: true, reason: "already submitted" } as const;

  const { body, segments } = buildSupervisorReminderSms();
  const jobKey = `${farmId}:${weekStart}:sat-reminder`;
  const res = await insertSmsIfNotExists({ farmId, jobKey, type: "supervisor-reminder", to, body, segments });
  return { sent: res.inserted, jobKey, segments, to, body, skipped: false as const };
}

// Weekly receipt for each worker — triggered on week.submitted (Saturday)
export async function sendWeeklyReceipts(opts: { farmId: string; weekStart: string }) {
  const { farmId, weekStart } = opts;
  const weekEnd = addDays(weekStart, 5);
  const db = await getDb();
  // Find all workers active in week
  const workersRes = await db.query(
    `SELECT DISTINCT payload->>'worker_id' as wid FROM events WHERE farm_id=$1 AND business_date >= $2 AND business_date <= $3 AND event_type='pluck.logged'`,
    [farmId, weekStart, weekEnd]
  );
  const results: Array<{ workerId: string; sent: boolean; jobKey: string }> = [];
  for (const r of workersRes.rows as Array<{ wid: string }>) {
    const wid = r.wid;
    if (!wid) continue;
    const wRes = await db.query("SELECT full_name, phone_e164, verified FROM workers WHERE worker_id=$1", [wid]);
    const w = (wRes.rows as Array<{ full_name: string; phone_e164: string; verified: boolean }>)[0];
    if (!w || !w.verified) continue; // Decision 3: no receipt until verified
    // Build tokens Mon-Sat
    const tokens: Record<string, string> = {};
    const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (let i = 0; i < 6; i++) {
      const d = addDays(weekStart, i);
      const pluckingRes = await db.query(`SELECT is_plucking_day FROM plucking_days WHERE farm_id=$1 AND date=$2`, [farmId, d]);
      const isPluckingDay = (pluckingRes.rows as Array<{ is_plucking_day: boolean }>)[0]?.is_plucking_day ?? true;
      if (!isPluckingDay) { tokens[dayNames[i]] = "NP"; continue; }
      const pluck = await db.query(`SELECT payload->>'kg_units' as kg_units, payload->>'present' as present FROM events WHERE farm_id=$1 AND business_date=$2 AND payload->>'worker_id'=$3 AND event_type='pluck.logged' LIMIT 1`, [farmId, d, wid]);
      const row = (pluck.rows as Array<{ kg_units: string; present: string }>)[0];
      if (!row) tokens[dayNames[i]] = "A";
      else if (row.present === "false") tokens[dayNames[i]] = "A";
      else tokens[dayNames[i]] = (Number(row.kg_units) / 10).toString();
    }
    // Total kg + amount
    const kgRes = await db.query(`SELECT SUM((payload->>'kg_units')::int) as sum FROM events WHERE farm_id=$1 AND payload->>'worker_id'=$2 AND business_date >= $3 AND business_date <= $4 AND event_type='pluck.logged'`, [farmId, wid, weekStart, weekEnd]);
    const totalKgUnits = Number((kgRes.rows as Array<{ sum: string }>)[0]?.sum ?? 0);
    const rateRes = await db.query("SELECT rate_cents_per_kg FROM rates WHERE farm_id=$1 ORDER BY effective_from DESC LIMIT 1", [farmId]);
    const rateCentsPerKg = (rateRes.rows as Array<{ rate_cents_per_kg: number }>)[0]?.rate_cents_per_kg ?? 900;
    // Calculate pay using core helper (one half-up rounding)
    const { calculateWorkerWeekPayKes } = await import("@tea-ledger/core");
    // Need per-date rates — for M5 simplify to single rate
    const entries = [{ kgUnits: totalKgUnits, rateCentsPerKg }];
    // Actually need split per pluck: fetch each pluck's kgUnits with rate
    // Simplified: fetch all plucks and compute
    const allPlucks = await db.query(`SELECT payload->>'kg_units' as kg_units FROM events WHERE farm_id=$1 AND payload->>'worker_id'=$2 AND business_date >= $3 AND business_date <= $4 AND event_type='pluck.logged'`, [farmId, wid, weekStart, weekEnd]);
    const payEntries = (allPlucks.rows as Array<{ kg_units: string }>).map(r => ({ kgUnits: Number(r.kg_units), rateCentsPerKg }));
    const amountKes = calculateWorkerWeekPayKes(payEntries);

    const weekLabel = `Wk ${weekStart}`;
    const { body, segments } = buildWeeklyReceiptSms({ workerName: w.full_name, tokens, totalKgUnits, rateCentsPerKg, amountKes, weekLabel });
    const jobKey = `${farmId}:${weekStart}:${wid}:weekly-receipt`;
    const ins = await insertSmsIfNotExists({ farmId, jobKey, type: "weekly-receipt", to: w.phone_e164, body, segments });
    results.push({ workerId: wid, sent: ins.inserted, jobKey });
  }
  return results;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00+03:00");
  d.setDate(d.getDate() + days);
  // Format in Africa/Nairobi
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find(p => p.type === "year")!.value;
  const m = parts.find(p => p.type === "month")!.value;
  const day = parts.find(p => p.type === "day")!.value;
  return `${y}-${m}-${day}`;
}

export async function listSmsLog(farmId?: string, limit = 100) {
  const db = await getDb();
  const res = farmId
    ? await db.query("SELECT * FROM sms_messages WHERE farm_id=$1 ORDER BY created_at DESC LIMIT $2", [farmId, limit])
    : await db.query("SELECT * FROM sms_messages ORDER BY created_at DESC LIMIT $1", [limit]);
  return res.rows;
}

export async function getSmsStats(farmId?: string) {
  const db = await getDb();
  const res = farmId
    ? await db.query("SELECT type, status, COUNT(*) as c, SUM(segments) as segs FROM sms_messages WHERE farm_id=$1 GROUP BY type, status", [farmId])
    : await db.query("SELECT type, status, COUNT(*) as c, SUM(segments) as segs FROM sms_messages GROUP BY type, status");
  return res.rows;
}
