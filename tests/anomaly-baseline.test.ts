/**
 * Regression tests for two data-integrity gaps found in the post-M8 audit:
 *
 * 1. APPROVED decision 2: late events for a locked week are kept and flagged as
 *    correction requests, and must NEVER be silently applied to that week's
 *    payroll sheet or SMS figures.
 * 2. APPROVED decision 11: the anomaly baseline is the average of the worker's
 *    previous completed payroll weeks, EXCLUDING weeks with no employment or no
 *    entries — computed from the append-only events, so it works even when no
 *    payroll_lines have ever been saved (first view / cold start / demo seed).
 *
 * These tests exercise the real DB layer (PGlite in tests, PostgreSQL in CI/owner
 * machine) end-to-end through getPayrollData + computePayrollSheet + the SMS
 * scheduler — not the pure helpers in isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, runMigrations, pushEvents, getPayrollData } from "@tea-ledger/database";
import { computePayrollSheet, generateEventId, getWeekEndSaturday } from "@tea-ledger/core";
import { sendDailyOwnerSms } from "../packages/sms/src/scheduler.js";
import type { DbClient } from "@tea-ledger/database";

let db: DbClient;
const farmId = "00000000-0000-4000-a000-0000000000aa";
const deviceId = "00000000-0000-4000-a000-0000000000bb";

// Workers
const wA = "00000000-0000-4000-a000-0000000000a1"; // Ana A — all 4 weeks
const wB = "00000000-0000-4000-a000-0000000000a2"; // Bena B — W2 is a no-entry week
const wC = "00000000-0000-4000-a000-0000000000a3"; // Ciri C — joins W3 (1 prior week)

// Weeks (Mon-Sat)
const W1 = "2026-11-02", W2 = "2026-11-09", W3 = "2026-11-16", W4 = "2026-11-23";

async function logPluck(workerId: string, date: string, kgUnits: number, present = true) {
  const ev = {
    event_id: generateEventId(),
    farm_id: farmId,
    device_id: deviceId,
    author: "supervisor",
    event_type: "pluck.logged",
    payload: { worker_id: workerId, kg_units: kgUnits, present },
    business_date: date,
    client_timestamp: new Date().toISOString(),
  };
  await pushEvents([ev as never], db as never);
}

async function submitWeek(weekStart: string) {
  const ev = {
    event_id: generateEventId(),
    farm_id: farmId,
    device_id: deviceId,
    author: "supervisor",
    event_type: "week.submitted",
    payload: {},
    business_date: getWeekEndSaturday(weekStart),
    client_timestamp: new Date().toISOString(),
  };
  await pushEvents([ev as never], db as never);
}

beforeAll(async () => {
  // The SMS scheduler reads the global getDb() singleton, so the whole file runs
  // against it. Farm id is unique, migrations are idempotent.
  db = await getDb();
  await runMigrations(db);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2) ON CONFLICT (farm_id) DO NOTHING", [farmId, "Baseline Farm"]);
  await db.query(
    "INSERT INTO rates (farm_id, effective_from, rate_cents_per_kg) VALUES ($1,'2020-01-01',900) ON CONFLICT DO NOTHING",
    [farmId],
  );
  await db.query(
    `INSERT INTO farm_settings (farm_id, settings) VALUES ($1, '{"ownerPhone":"+254700000099"}'::jsonb)
     ON CONFLICT (farm_id) DO UPDATE SET settings = excluded.settings`,
    [farmId],
  );
  for (const [id, name, phone, start] of [
    [wA, "Ana A", "+254700000001", "2026-11-01"],
    [wB, "Bena B", "+254700000002", "2026-11-01"],
    [wC, "Ciri C", "+254700000003", "2026-11-16"],
  ] as const) {
    await db.query(
      "INSERT INTO workers (worker_id, farm_id, full_name, phone_e164, status, verified, consent_at, consent_author) VALUES ($1,$2,$3,$4,'active',true,NOW(),'test')",
      [id, farmId, name, phone],
    );
    await db.query(
      "INSERT INTO employment_periods (id, worker_id, farm_id, start_date, end_date) VALUES ($1,$2,$3,$4,null)",
      [crypto.randomUUID(), id, farmId, start],
    );
  }

  // W1: A 10kg (100 units) Mon, B 20kg (200 units) Tue
  await logPluck(wA, "2026-11-02", 100);
  await logPluck(wB, "2026-11-03", 200);
  await submitWeek(W1);
  // W2: A 20kg only — B is employed but has NO entries this week
  await logPluck(wA, "2026-11-09", 200);
  await submitWeek(W2);
  // W3: A 15kg, B 30kg, C 10kg (C's first week)
  await logPluck(wA, "2026-11-16", 150);
  await logPluck(wB, "2026-11-17", 300);
  await logPluck(wC, "2026-11-16", 100);
  await submitWeek(W3);
  // Late event for LOCKED W1: A 50kg on Tue 2026-11-03 — must be flagged, never applied
  await logPluck(wA, "2026-11-03", 500);
  // W4 (open) entries: A 100kg (huge jump), B 20kg (normal), C 10kg (only 1 prior week)
  await logPluck(wA, "2026-11-23", 1000);
  await logPluck(wB, "2026-11-24", 200);
  await logPluck(wC, "2026-11-25", 100);
});

afterAll(async () => {
  if (db?.end) await db.end();
});

describe("decision 2 — locked weeks never silently apply late events", () => {
  it("locked week sheet excludes correction-flagged entries", async () => {
    const data = await getPayrollData({ farmId, weekStart: W1, weekEnd: getWeekEndSaturday(W1), dbClient: db as never });
    const sheet = computePayrollSheet({
      farmId,
      weekStart: W1,
      weekEnd: getWeekEndSaturday(W1),
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
    const lineA = sheet.lines.find((l) => l.workerId === wA)!;
    const lineB = sheet.lines.find((l) => l.workerId === wB)!;
    // 10kg and 20kg — the late 50kg (500 units) must NOT appear
    expect(lineA.totalKgUnits).toBe(100);
    expect(lineA.totalKg).toBe(10);
    expect(lineB.totalKgUnits).toBe(200);
    expect(sheet.totals.totalKgUnits).toBe(300);
    // ...and the late event is preserved as a correction request
    const corr = await db.query(
      "SELECT event_id FROM events WHERE farm_id=$1 AND correction_flag=true AND business_date='2026-11-03'",
      [farmId],
    );
    expect((corr.rows as unknown[]).length).toBe(1);
  });

  it("daily Owner SMS excludes correction-flagged entries", async () => {
    const res = (await sendDailyOwnerSms({ farmId, date: "2026-11-03" })) as { skipped?: boolean; body: string };
    expect(res.skipped).toBeFalsy();
    // B's 20kg counts; A's late 50kg must not be in the figures or lines
    expect(res.body).toContain("Total 20kg");
    expect(res.body).toContain("Bena B 20");
    expect(res.body).not.toContain("Ana A");
    expect(res.body).not.toContain("50");
  });
});

describe("decision 11 — anomaly baseline from events (no payroll_lines needed)", () => {
  it("prior amounts computed from events, excluding no-entry weeks and late events", async () => {
    const data = await getPayrollData({ farmId, weekStart: W4, weekEnd: getWeekEndSaturday(W4), dbClient: db as never });
    // A: W1 90 KES (not 540 — late event excluded), W2 180, W3 135
    expect(data.priorAmountsByWorker.get(wA)).toEqual([90, 180, 135]);
    // B: W1 180, W2 EXCLUDED (employed but no entries), W3 270
    expect(data.priorAmountsByWorker.get(wB)).toEqual([180, 270]);
    // C: first week W3 only
    expect(data.priorAmountsByWorker.get(wC)).toEqual([90]);
  });

  it("anomaly flags a >50% jump; healthy week stays unflagged", async () => {
    const data = await getPayrollData({ farmId, weekStart: W4, weekEnd: getWeekEndSaturday(W4), dbClient: db as never });
    const sheet = computePayrollSheet({
      farmId,
      weekStart: W4,
      weekEnd: getWeekEndSaturday(W4),
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
    const lineA = sheet.lines.find((l) => l.workerId === wA)!; // 900 vs avg 135
    expect(lineA.flags.some((f) => f.startsWith("anomaly"))).toBe(true);
    expect(lineA.flags).not.toContain("limited history");
    const lineB = sheet.lines.find((l) => l.workerId === wB)!; // 180 vs avg 225 = 20%
    expect(lineB.flags.some((f) => f.startsWith("anomaly"))).toBe(false);
    expect(lineB.flags).not.toContain("limited history");
    const lineC = sheet.lines.find((l) => l.workerId === wC)!; // only 1 valid prior week
    expect(lineC.flags).toContain("limited history");
    expect(lineC.flags.some((f) => f.startsWith("anomaly"))).toBe(false);
  });
});
