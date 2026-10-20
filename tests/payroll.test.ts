import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, runMigrations } from "@tea-ledger/database";
import { pushEvents } from "@tea-ledger/database";
import { getPayrollData } from "@tea-ledger/database";
import { computePayrollSheet } from "@tea-ledger/core";
import { generateEventId, getWeekStartMonday, getWeekEndSaturday } from "@tea-ledger/core";
import type { DbClient } from "@tea-ledger/database";

let db: DbClient;
const farmId = "00000000-0000-4000-a000-000000000010";
const deviceId = "00000000-0000-4000-a000-000000000011";

beforeAll(async () => {
  db = await createTestDb();
  await runMigrations(db);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [farmId, "Payroll Test Farm"]);
  await db.query("INSERT INTO rates (farm_id, effective_from, rate_cents_per_kg) VALUES ($1,'2020-01-01',900) ON CONFLICT DO NOTHING", [farmId]);
});

afterAll(async () => {
  if (db?.end) await db.end();
});

async function registerWorker(workerId: string, name: string, phone: string, verified = true) {
  await db.query("INSERT INTO workers (worker_id, farm_id, full_name, phone_e164, status, verified, consent_at, consent_author) VALUES ($1,$2,$3,$4,'active',$5,NOW(),'test')", [workerId, farmId, name, phone, verified]);
  await db.query("INSERT INTO employment_periods (id, worker_id, farm_id, start_date, end_date) VALUES ($1,$2,$3,$4,null)", [crypto.randomUUID(), workerId, farmId, "2026-11-16"]);
}

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

async function submitWeek(weekEnd: string) {
  const ev = {
    event_id: generateEventId(),
    farm_id: farmId,
    device_id: deviceId,
    author: "supervisor",
    event_type: "week.submitted",
    payload: {},
    business_date: weekEnd,
    client_timestamp: new Date().toISOString(),
  };
  await pushEvents([ev as never], db as never);
}

describe("M6 payroll — pure calc + Saturday lock + CSV", () => {
  const w1 = "00000000-0000-4000-a000-000000000021";
  const w2 = "00000000-0000-4000-a000-000000000022";
  const w3 = "00000000-0000-4000-a000-000000000023"; // unverified

  it("computes simple week, rate per date, half-up rounding, printable totals", async () => {
    await registerWorker(w1, "Kiptoo Ke", "+254712000001", true);
    await registerWorker(w2, "Akinyi Bo", "+254712000002", true);
    await registerWorker(w3, "Mutei Ci", "+254712000003", false);

    // Week 2026-11-23 (Mon) to 2026-11-28 (Sat)
    const weekStart = "2026-11-23";
    const weekEnd = getWeekEndSaturday(weekStart);
    expect(weekEnd).toBe("2026-11-28");

    // Mon: w1 40kg (400 tenths), w2 30kg, w3 absent? we log 0
    await logPluck(w1, "2026-11-23", 400, true);
    await logPluck(w2, "2026-11-23", 300, true);
    // Tue
    await logPluck(w1, "2026-11-24", 350, true);
    await logPluck(w2, "2026-11-24", 250, true);
    await logPluck(w3, "2026-11-24", 0, true); // present with 0kg
    // Wed - will be no-plucking in next test, but for now normal
    await logPluck(w1, "2026-11-25", 200, true);
    // Thu
    await logPluck(w1, "2026-11-26", 100, true);
    await logPluck(w2, "2026-11-27", 120, true); // Fri
    await logPluck(w1, "2026-11-28", 80, true); // Sat

    const data = await getPayrollData({ farmId, weekStart, weekEnd, dbClient: db as never });
    expect(data.workers.length).toBe(3);
    expect(data.pluckingDays.length).toBe(6);

    const sheet = computePayrollSheet({
      farmId,
      weekStart,
      weekEnd,
      status: "open",
      lockedAt: null,
      workers: data.workers,
      plucksByWorker: data.plucksByWorker,
      pluckingDays: data.pluckingDays,
      rates: data.rates,
      adjustmentsByWorker: data.adjustmentsByWorker,
      priorAmountsByWorker: data.priorAmountsByWorker,
      firstWeekByWorker: data.firstWeekByWorker,
    });

    // w1: 400+350+200+100+80 = 1130 tenths = 113kg @9 = 1017 KES
    const kiptoo = sheet.lines.find((l) => l.workerId === w1)!;
    expect(kiptoo.totalKg).toBe(113);
    expect(kiptoo.totalKgUnits).toBe(1130);
    expect(kiptoo.amountKes).toBe(1017); // 113*9=1017, integer exact
    expect(kiptoo.daysWorked).toBe(5);
    // w2: 300+250+120 = 670 tenths = 67kg @9 = 603
    const akinyi = sheet.lines.find((l) => l.workerId === w2)!;
    expect(akinyi.totalKg).toBe(67);
    expect(akinyi.amountKes).toBe(603);
    // w3 present with 0kg flag
    const mutei = sheet.lines.find((l) => l.workerId === w3)!;
    expect(mutei.flags).toContain("present with 0kg");
    expect(mutei.flags).toContain("unverified number");

    // Grand total is sum of rounded
    expect(sheet.totals.totalKg).toBe(180);
    expect(sheet.totals.totalAmountKes).toBe(kiptoo.amountKes + akinyi.amountKes + mutei.amountKes);

    // CSV contains totals row and headers
    const { payrollToCsv } = await import("@tea-ledger/core");
    const csv = payrollToCsv(sheet);
    expect(csv).toContain("worker_id,name");
    expect(csv).toContain("TOTALS");
    expect(csv).toContain("Kiptoo");

    // Printable HTML
    const { payrollToPrintableHtml } = await import("@tea-ledger/core");
    const html = payrollToPrintableHtml(sheet, "Test Farm");
    expect(html).toContain("Payroll Sheet");
    expect(html).toContain("Print / Save as PDF");
  });

  it("mid-week rate change weighted correctly", async () => {
    // Change rate effective 2026-11-25 to 10 KES/kg (1000 cents)
    await db.query("INSERT INTO rates (farm_id, effective_from, rate_cents_per_kg) VALUES ($1,$2,$3) ON CONFLICT (farm_id, effective_from) DO UPDATE SET rate_cents_per_kg=$3", [farmId, "2026-11-25", 1000]);

    const weekStart = "2026-11-23";
    const weekEnd = getWeekEndSaturday(weekStart);
    const data = await getPayrollData({ farmId, weekStart, weekEnd, dbClient: db as never });
    const sheet = computePayrollSheet({
      farmId,
      weekStart,
      weekEnd,
      status: "open",
      lockedAt: null,
      workers: data.workers,
      plucksByWorker: data.plucksByWorker,
      pluckingDays: data.pluckingDays,
      rates: data.rates,
      adjustmentsByWorker: data.adjustmentsByWorker,
      priorAmountsByWorker: data.priorAmountsByWorker,
      firstWeekByWorker: data.firstWeekByWorker,
    });
    const kiptoo = sheet.lines.find((l) => l.workerId === w1)!;
    // w1: Mon 40@9, Tue 35@9, Wed 20@10, Thu 10@10, Sat 8@10
    // Mon+Tue = 75kg @9 = 67500 cents, Wed+Thu+Sat = 38kg @10 = 38000 => total 105500 cents => 1055 KES half-up
    expect(kiptoo.amountKes).toBe(1055);
    expect(kiptoo.rateBands.length).toBe(2);
    expect(kiptoo.rateCentsPerKg).toBeGreaterThan(900);
    expect(kiptoo.rateCentsPerKg).toBeLessThan(1000);

    // Reset rate for other tests
    await db.query("DELETE FROM rates WHERE farm_id=$1 AND effective_from='2026-11-25'", [farmId]);
  });

  it("Saturday lock makes correction flagged, adjustment moves to next week", async () => {
    const weekStart = "2026-11-23";
    const weekEnd = getWeekEndSaturday(weekStart);
    await submitWeek(weekEnd);

    // Check locked
    const pwRes = await db.query("SELECT status FROM pay_weeks WHERE farm_id=$1 AND week_start=$2", [farmId, weekStart]);
    expect((pwRes.rows as Array<{ status: string }>)[0].status).toBe("locked");

    // Try to log late event for locked week -> flagged as correction
    const lateEv = {
      event_id: generateEventId(),
      farm_id: farmId,
      device_id: deviceId,
      author: "supervisor",
      event_type: "pluck.logged",
      payload: { worker_id: w1, kg_units: 50, present: true },
      business_date: "2026-11-24",
      client_timestamp: new Date().toISOString(),
    };
    const pushRes = await pushEvents([lateEv as never], db as never);
    expect(pushRes.flaggedAsCorrection).toBe(1);

    const corrRes = await db.query("SELECT event_id FROM events WHERE event_id=$1 AND correction_flag=true", [lateEv.event_id]);
    expect((corrRes.rows as unknown[]).length).toBe(1);

    // Admin creates adjustment for next week (2026-11-30)
    const { createAdjustment } = await import("@tea-ledger/database");
    const adj = await createAdjustment({
      farmId,
      workerId: w1,
      correctionWeekStart: weekStart,
      kgUnits: 50,
      rateCentsPerKg: 900,
      reason: "missed entry on 2026-11-24, moved per correction",
      dbClient: db as never,
    });
    expect(adj.nextWeekStart).toBe("2026-11-30");

    const adjCheck = await db.query("SELECT * FROM adjustments WHERE farm_id=$1 AND week_start=$2", [farmId, "2026-11-30"]);
    expect((adjCheck.rows as unknown[]).length).toBe(1);

    // Next week payroll includes adjustment
    const nextWeekStart = "2026-11-30";
    const nextWeekEnd = getWeekEndSaturday(nextWeekStart);
    // Log some kg in next week to have a line, plus adjustment
    await logPluck(w1, "2026-11-30", 100, true); // 10kg Mon
    const nextData = await getPayrollData({ farmId, weekStart: nextWeekStart, weekEnd: nextWeekEnd, dbClient: db as never });
    const nextSheet = computePayrollSheet({
      farmId,
      weekStart: nextWeekStart,
      weekEnd: nextWeekEnd,
      status: "open",
      lockedAt: null,
      workers: nextData.workers,
      plucksByWorker: nextData.plucksByWorker,
      pluckingDays: nextData.pluckingDays,
      rates: nextData.rates,
      adjustmentsByWorker: nextData.adjustmentsByWorker,
      priorAmountsByWorker: nextData.priorAmountsByWorker,
      firstWeekByWorker: nextData.firstWeekByWorker,
    });
    const line = nextSheet.lines.find((l) => l.workerId === w1)!;
    // 10kg + 5kg adj = 15kg @9 = 135 KES
    expect(line.totalKg).toBe(15);
    expect(line.adjustmentAmountKes).toBe(45); // 5kg @9 =45
  });

  it("anomaly flagged when >50% deviation, limited history when <2 prior weeks", async () => {
    // We have 1 locked week (2026-11-23) now, so prior history for next tests is 1 -> limited history
    const { computePayrollLine } = await import("@tea-ledger/core");
    const worker: import("@tea-ledger/core").WorkerInfo = {
      workerId: w1,
      fullName: "Kiptoo",
      phoneE164: "+254712000001",
      verified: true,
      employmentPeriods: [{ startDate: "2026-11-16", endDate: null }],
    };
    const lineLimited = computePayrollLine({
      worker,
      entries: [{ workerId: w1, businessDate: "2026-11-30", kgUnits: 100, present: true }],
      pluckingDays: [{ date: "2026-11-30", isPluckingDay: true }],
      rates: [{ effectiveFrom: "2020-01-01", rateCentsPerKg: 900 }],
      adjustmentsForThisWeek: [],
      priorWeekAmounts: [100], // only 1 prior
      isFirstWeek: false,
    });
    expect(lineLimited.flags).toContain("limited history");

    const lineAnomaly = computePayrollLine({
      worker,
      entries: [{ workerId: w1, businessDate: "2026-11-30", kgUnits: 700, present: true }], // 70kg @9 =630 vs avg 100 => 530% deviation
      pluckingDays: [{ date: "2026-11-30", isPluckingDay: true }],
      rates: [{ effectiveFrom: "2020-01-01", rateCentsPerKg: 900 }],
      adjustmentsForThisWeek: [],
      priorWeekAmounts: [100, 110, 90, 105], // avg 101, current 630 => huge
      isFirstWeek: false,
    });
    expect(lineAnomaly.flags.some((f) => f.startsWith("anomaly"))).toBe(true);
  });
});
