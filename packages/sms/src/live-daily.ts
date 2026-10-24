import { randomUUID } from "node:crypto";
import { getDb } from "@tea-ledger/database";
import {
  buildCompactDailyOwnerSms,
  buildDailyAbsentSms,
  buildDailyNoPluckingSms,
  buildDailyWorkerSms,
  calculateWorkerWeekPayKes,
  countSegments,
} from "@tea-ledger/core";
import { createMobileSasaAdapter, MOBILE_SASA_PART_COST_CENTS } from "./mobilesasa.js";
import type { SmsAdapter } from "./types.js";

/**
 * This is intentionally a narrow, explicit live path. Existing cron/weekly SMS
 * behaviour stays mock-only. A farm must be named in the deployment environment
 * before a completed day can spend a Mobile Sasa unit.
 */
export function isLiveDailySmsEnabledForFarm(farmId: string): boolean {
  return process.env.DAILY_LIVE_SMS_ENABLED === "true" && process.env.DAILY_LIVE_SMS_FARM_ID === farmId;
}

type Recipient = {
  workerId: string;
  name: string;
  phone: string;
  present: boolean;
  kgUnits: number | null;
};

type SendResult = { sent: boolean; skipped: boolean; failed: boolean; id?: string };

function formatDateLabel(date: string): string {
  return new Date(`${date}T12:00:00+03:00`)
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "Africa/Nairobi" })
    .replace(",", "");
}

function normaliseKenyaPhone(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/[\s()-]/g, "");
  if (/^\+254(?:7|1)\d{8}$/.test(cleaned)) return cleaned;
  if (/^254(?:7|1)\d{8}$/.test(cleaned)) return `+${cleaned}`;
  if (/^0(?:7|1)\d{8}$/.test(cleaned)) return `+254${cleaned.slice(1)}`;
  return null;
}

function liveAdapter(): SmsAdapter | null {
  const token = process.env.MOBILESASA_TOKEN?.trim();
  if (!token) return null;
  // Do not configure or buy a custom sender. Daily messages always use the
  // account's existing shared MOBILESASA sender.
  return createMobileSasaAdapter({
    token,
    // Daily rollout is deliberately pinned to the existing shared sender;
    // no custom/paid sender can be enabled through deployment variables.
    senderId: "MOBILESASA",
  });
}

async function persistOnce(opts: {
  farmId: string;
  jobKey: string;
  type: string;
  to: string;
  body: string;
  adapter: SmsAdapter | null;
}): Promise<SendResult> {
  const db = await getDb();
  const id = randomUUID();
  const predictedSegments = countSegments(opts.body);
  const inserted = await db.query(
    `INSERT INTO sms_messages (id, farm_id, type, to_phone, body, segments, status, provider_id, job_key, cost_estimate_cents)
     VALUES ($1,$2,$3,$4,$5,$6,'queued',NULL,$7,$8)
     ON CONFLICT DO NOTHING`,
    [
      id,
      opts.farmId,
      opts.type,
      opts.to,
      opts.body,
      predictedSegments,
      opts.jobKey,
      predictedSegments * MOBILE_SASA_PART_COST_CENTS,
    ],
  );
  if ((inserted.rowCount ?? 0) === 0) return { sent: false, skipped: true, failed: false };

  if (!opts.adapter) {
    await db.query("UPDATE sms_messages SET status='failed' WHERE id=$1", [id]);
    return { sent: false, skipped: false, failed: true, id };
  }

  try {
    const sent = await opts.adapter.send({
      to: opts.to,
      body: opts.body,
      farmId: opts.farmId,
      type: opts.type,
      trackingId: id,
    });
    await db.query(
      "UPDATE sms_messages SET segments=$1, status=$2, provider_id=$3, cost_estimate_cents=$4 WHERE id=$5",
      [sent.segments, sent.status, sent.providerId ?? null, sent.costEstimateCents ?? null, id],
    );
    return { sent: true, skipped: false, failed: false, id };
  } catch (error) {
    // Fail closed: the idempotency row remains failed and the sync replay will
    // not silently produce a second handset message after an ambiguous timeout.
    await db.query("UPDATE sms_messages SET status='failed' WHERE id=$1", [id]);
    console.error("[live-daily-sms] send failed", error instanceof Error ? error.message : String(error));
    return { sent: false, skipped: false, failed: true, id };
  }
}

async function effectiveRateCentsPerKg(farmId: string, date: string): Promise<number> {
  const db = await getDb();
  const result = await db.query(
    "SELECT rate_cents_per_kg FROM rates WHERE farm_id=$1 AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1",
    [farmId, date],
  );
  return Number((result.rows as Array<{ rate_cents_per_kg?: number }>)[0]?.rate_cents_per_kg ?? 900);
}

async function dailyRecipients(farmId: string, date: string): Promise<Recipient[]> {
  const db = await getDb();
  const result = await db.query(
    `SELECT w.worker_id,
            e.payload->>'kg_units' AS kg_units,
            e.payload->>'present' AS present,
            e.event_id,
            w.full_name,
            w.phone_e164
       FROM workers w
       JOIN employment_periods ep ON ep.worker_id=w.worker_id AND ep.farm_id=w.farm_id
       LEFT JOIN events e ON e.farm_id=w.farm_id
            AND e.business_date=$2
            AND e.event_type='pluck.logged'
            AND e.payload->>'worker_id'=w.worker_id::text
            AND e.correction_flag=false
            AND e.conflict_flag=false
      WHERE w.farm_id=$1
        AND w.consent_at IS NOT NULL
        AND w.phone_e164 IS NOT NULL
        AND ep.start_date <= $2
        AND (ep.end_date IS NULL OR ep.end_date >= $2)
      ORDER BY w.full_name ASC, e.server_received_at ASC`,
    [farmId, date],
  );

  // A completed day reaches every consented picker employed on that date. A
  // blank row is communicated honestly as no kg/pay recorded, rather than
  // silently omitting a worker. Conflicted records are never chosen.
  return (result.rows as Array<{ worker_id: string; kg_units: string | null; present: string | null; event_id: string | null; full_name: string; phone_e164: string }>)
    .map((row) => ({
      workerId: row.worker_id,
      name: row.full_name,
      phone: row.phone_e164,
      present: row.event_id !== null && row.present !== "false" && row.kg_units !== null,
      kgUnits: row.kg_units === null ? null : Number(row.kg_units),
    }))
    .filter((row) => row.workerId && row.phone && (row.kgUnits === null || Number.isFinite(row.kgUnits)));
}

async function noPluckingRecipients(farmId: string, date: string): Promise<Recipient[]> {
  const db = await getDb();
  const result = await db.query(
    `SELECT DISTINCT w.worker_id, w.full_name, w.phone_e164
       FROM workers w
       JOIN employment_periods ep ON ep.worker_id=w.worker_id AND ep.farm_id=w.farm_id
      WHERE w.farm_id=$1
        AND w.consent_at IS NOT NULL
        AND w.phone_e164 IS NOT NULL
        AND ep.start_date <= $2
        AND (ep.end_date IS NULL OR ep.end_date >= $2)
      ORDER BY w.full_name ASC`,
    [farmId, date],
  );
  return (result.rows as Array<{ worker_id: string; full_name: string; phone_e164: string }>).map((row) => ({
    workerId: row.worker_id,
    name: row.full_name,
    phone: row.phone_e164,
    present: false,
    kgUnits: null,
  }));
}

function testOwnerPhone(): string | null {
  return normaliseKenyaPhone(process.env.DAILY_LIVE_SMS_OWNER_TEST_PHONE);
}

/**
 * Sends individual daily messages to consented workers employed on the completed
 * day, then sends Peter's compact owner summary to the temporary test recipient.
 * It is called only after the complete day has been accepted by the server.
 */
export async function sendLiveDailySms(opts: { farmId: string; date: string }) {
  if (!isLiveDailySmsEnabledForFarm(opts.farmId)) return { skipped: true, reason: "live daily SMS disabled" } as const;
  const ownerPhone = testOwnerPhone();
  if (!ownerPhone) return { skipped: true, reason: "daily owner test phone is not configured" } as const;
  const adapter = liveAdapter();
  // A partially configured deployment must not consume the idempotency key and
  // turn a later valid rollout into an apparent permanent delivery failure.
  if (!adapter) return { skipped: true, reason: "Mobile Sasa token is not configured" } as const;

  const recipients = await dailyRecipients(opts.farmId, opts.date);
  if (recipients.length === 0) return { skipped: true, reason: "no consented workers employed on this day" } as const;
  const dateLabel = formatDateLabel(opts.date);
  const rateCentsPerKg = await effectiveRateCentsPerKg(opts.farmId, opts.date);
  const workerResults: SendResult[] = [];
  const ownerLines: Array<{ name: string; kgUnits: number; amountKes: number }> = [];

  for (const recipient of recipients) {
    const phone = normaliseKenyaPhone(recipient.phone);
    if (!phone) continue;
    let body: string;
    if (!recipient.present) {
      body = buildDailyAbsentSms({ dateLabel }).body;
    } else if (recipient.kgUnits !== null) {
      // Shared integer money core: the daily figure is an estimate, but it
      // follows the same half-up KES rounding as payroll rather than browser math.
      const amountKes = calculateWorkerWeekPayKes([{ kgUnits: recipient.kgUnits, rateCentsPerKg }]);
      body = buildDailyWorkerSms({ dateLabel, kgUnits: recipient.kgUnits, amountKes }).body;
      ownerLines.push({ name: recipient.name, kgUnits: recipient.kgUnits, amountKes });
    } else {
      // No kg field is not a safe basis for a financial message.
      continue;
    }
    workerResults.push(await persistOnce({
      farmId: opts.farmId,
      jobKey: `${opts.farmId}:${opts.date}:live-daily-worker:${recipient.workerId}`,
      type: "daily-worker-live",
      to: phone,
      body,
      adapter,
    }));
  }

  const totalKgUnits = ownerLines.reduce((sum, line) => sum + line.kgUnits, 0);
  const totalPayEstimateKes = ownerLines.reduce((sum, line) => sum + line.amountKes, 0);
  const ownerBody = buildCompactDailyOwnerSms({
    dateLabel,
    totalKgUnits,
    pickerCount: ownerLines.length,
    totalPayEstimateKes,
    lines: ownerLines,
  }).body;
  const ownerResult = await persistOnce({
    farmId: opts.farmId,
    jobKey: `${opts.farmId}:${opts.date}:live-daily-owner`,
    type: "daily-owner-live",
    to: ownerPhone,
    body: ownerBody,
    adapter,
  });

  return {
    skipped: false,
    workers: workerResults,
    owner: ownerResult,
    totalKgUnits,
    totalPayEstimateKes,
  } as const;
}

/** Sends a no-plucking notice to the same consented employment roster and owner test recipient. */
export async function sendLiveNoPluckingSms(opts: { farmId: string; date: string; reason?: string }) {
  if (!isLiveDailySmsEnabledForFarm(opts.farmId)) return { skipped: true, reason: "live daily SMS disabled" } as const;
  const ownerPhone = testOwnerPhone();
  if (!ownerPhone) return { skipped: true, reason: "daily owner test phone is not configured" } as const;
  const adapter = liveAdapter();
  if (!adapter) return { skipped: true, reason: "Mobile Sasa token is not configured" } as const;
  const dateLabel = formatDateLabel(opts.date);
  const body = buildDailyNoPluckingSms({ dateLabel, reason: opts.reason ?? "not recorded" }).body;
  const recipients = await noPluckingRecipients(opts.farmId, opts.date);
  const workers = await Promise.all(recipients.map(async (recipient) => {
    const phone = normaliseKenyaPhone(recipient.phone);
    if (!phone) return { sent: false, skipped: true, failed: false } as SendResult;
    return persistOnce({
      farmId: opts.farmId,
      jobKey: `${opts.farmId}:${opts.date}:live-no-plucking-worker:${recipient.workerId}`,
      type: "no-plucking-worker-live",
      to: phone,
      body,
      adapter,
    });
  }));
  const owner = await persistOnce({
    farmId: opts.farmId,
    jobKey: `${opts.farmId}:${opts.date}:live-no-plucking-owner`,
    type: "no-plucking-owner-live",
    to: ownerPhone,
    body,
    adapter,
  });
  return { skipped: false, workers, owner } as const;
}
