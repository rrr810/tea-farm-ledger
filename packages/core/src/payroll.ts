import { calculateWorkerWeekPayCents, computeWeightedRate } from "./money.js";
import { maskPhone } from "./phone.js";

export type RateEntry = { effectiveFrom: string; rateCentsPerKg: number };

export function rateForDate(dateStr: string, rates: RateEntry[], defaultCents = 900): number {
  // rates sorted ASC by effectiveFrom, pick last where effectiveFrom <= dateStr
  let best = defaultCents;
  let bestDate = "";
  for (const r of rates) {
    if (r.effectiveFrom <= dateStr && r.effectiveFrom >= bestDate) {
      best = r.rateCentsPerKg;
      bestDate = r.effectiveFrom;
    }
  }
  return best;
}

export type PluckEntry = {
  workerId: string;
  businessDate: string;
  kgUnits: number | null; // null if absent, 0 if present with zero
  present: boolean;
};

export type WorkerInfo = {
  workerId: string;
  fullName: string;
  phoneE164: string | null;
  verified: boolean;
  employmentPeriods: Array<{ startDate: string; endDate: string | null }>;
};

export type Adjustment = {
  workerId: string;
  kgUnits: number;
  rateCentsPerKg: number;
  reason: string;
};

export type PayrollLineInput = {
  worker: WorkerInfo;
  entries: PluckEntry[]; // plucks for this worker in week
  pluckingDays: Array<{ date: string; isPluckingDay: boolean }>;
  rates: RateEntry[];
  adjustmentsForThisWeek: Adjustment[]; // adjustments applied to this week (from prior week corrections)
  priorWeekAmounts: number[]; // last up to 4 completed week amounts in KES for anomaly
  isFirstWeek: boolean;
};

export type PayrollLine = {
  workerId: string;
  name: string;
  maskedPhone: string;
  phoneE164: string | null;
  verified: boolean;
  daysWorked: number;
  attendanceDenominator: number; // plucking days during active employment
  attendanceRate: number | null; // daysWorked / denom or null if denom 0
  totalKgUnits: number;
  totalKg: number;
  rateCentsPerKg: number; // weighted
  rateBands: Array<{ rateCentsPerKg: number; kgUnits: number }>;
  amountCents: number;
  amountKes: number;
  isNewWorkerFirstWeek: boolean;
  flags: string[];
  adjustments: Adjustment[];
  adjustmentAmountCents: number;
  adjustmentAmountKes: number;
};

export type PayrollSheet = {
  farmId: string;
  weekStart: string;
  weekEnd: string;
  status: "open" | "locked" | "incomplete";
  lockedAt: string | null;
  lines: PayrollLine[];
  totals: {
    totalKgUnits: number;
    totalKg: number;
    totalAmountCents: number;
    totalAmountKes: number;
    pickerCount: number;
    adjustmentsTotalCents: number;
  };
  flags: {
    toleranceExceeded: boolean;
  };
};

export function isActiveOnPayroll(dateStr: string, periods: WorkerInfo["employmentPeriods"]): boolean {
  for (const p of periods) {
    if (dateStr < p.startDate) continue;
    if (p.endDate && dateStr > p.endDate) continue;
    return true;
  }
  return false;
}

export function computePayrollLine(input: PayrollLineInput): PayrollLine {
  const { worker, entries, pluckingDays, rates, adjustmentsForThisWeek, priorWeekAmounts, isFirstWeek } = input;

  // Filter entries to only dates where worker was active (should already be, but enforce)
  const activeEntries = entries.filter((e) => isActiveOnPayroll(e.businessDate, worker.employmentPeriods));

  // Build per-date rate entries for pay calc
  const payEntries: Array<{ kgUnits: number; rateCentsPerKg: number }> = [];
  let totalKgUnits = 0;
  for (const e of activeEntries) {
    if (!e.present) continue;
    const kgUnits = e.kgUnits ?? 0;
    // present with 0kg is allowed, counts as entry but no pay
    if (kgUnits === 0) continue;
    const rate = rateForDate(e.businessDate, rates);
    payEntries.push({ kgUnits, rateCentsPerKg: rate });
    totalKgUnits += kgUnits;
  }

  // Add adjustments as extra pay entries
  for (const adj of adjustmentsForThisWeek) {
    payEntries.push({ kgUnits: adj.kgUnits, rateCentsPerKg: adj.rateCentsPerKg });
    totalKgUnits += adj.kgUnits;
  }

  const amountCents = payEntries.length > 0 ? calculateWorkerWeekPayCents(payEntries) : 0;
  const amountKes = Math.round(amountCents / 100);
  const weighted = payEntries.length > 0 ? computeWeightedRate(payEntries) : { totalKgUnits: 0, totalCentsBeforeRounding: 0, weightedRateCentsPerKg: 0, bands: [] };

  // Days worked: present (including present-with-zero-kg) on plucking days where active
  const presentEntries = activeEntries.filter((e) => e.present);
  const daysWorked = presentEntries.length;

  // Attendance denominator: plucking days during active employment period
  let denom = 0;
  for (const pd of pluckingDays) {
    if (!pd.isPluckingDay) continue;
    if (!isActiveOnPayroll(pd.date, worker.employmentPeriods)) continue;
    denom++;
  }
  const attendanceRate = denom > 0 ? daysWorked / denom : null;

  // Flags
  const flags: string[] = [];
  if (!worker.verified) flags.push("unverified number");
  if (activeEntries.some((e) => e.present && (e.kgUnits === 0 || e.kgUnits === null))) {
    flags.push("present with 0kg");
  }
  if (isFirstWeek) flags.push("first week for worker");

  // Anomaly: compare current amountKes vs avg of prior 4 weeks
  const validPrior = priorWeekAmounts.filter((v) => v !== null && v !== undefined);
  if (validPrior.length >= 2) {
    const avg = validPrior.slice(-4).reduce((a, b) => a + b, 0) / Math.min(validPrior.length, 4);
    if (avg > 0) {
      const deviation = Math.abs(amountKes - avg) / avg;
      if (deviation > 0.5) {
        flags.push(`anomaly: ${amountKes} vs avg ${Math.round(avg)} (${Math.round(deviation * 100)}% deviation)`);
      }
    }
  } else if (validPrior.length < 2 && validPrior.length > 0) {
    flags.push("limited history");
  } else if (validPrior.length === 0 && !isFirstWeek) {
    flags.push("limited history");
  }

  // Adjustment amounts
  let adjCents = 0;
  for (const adj of adjustmentsForThisWeek) {
    adjCents += calculateWorkerWeekPayCents([{ kgUnits: adj.kgUnits, rateCentsPerKg: adj.rateCentsPerKg }]);
  }

  return {
    workerId: worker.workerId,
    name: worker.fullName,
    maskedPhone: worker.phoneE164 ? maskPhone(worker.phoneE164) : "***",
    phoneE164: worker.phoneE164,
    verified: worker.verified,
    daysWorked,
    attendanceDenominator: denom,
    attendanceRate,
    totalKgUnits,
    totalKg: totalKgUnits / 10,
    rateCentsPerKg: weighted.weightedRateCentsPerKg,
    rateBands: weighted.bands,
    amountCents,
    amountKes,
    isNewWorkerFirstWeek: isFirstWeek,
    flags,
    adjustments: adjustmentsForThisWeek,
    adjustmentAmountCents: adjCents,
    adjustmentAmountKes: Math.round(adjCents / 100),
  };
}

export function computePayrollSheet(opts: {
  farmId: string;
  weekStart: string;
  weekEnd: string;
  status: "open" | "locked" | "incomplete";
  lockedAt: string | null;
  workers: WorkerInfo[];
  plucksByWorker: Map<string, PluckEntry[]>;
  pluckingDays: Array<{ date: string; isPluckingDay: boolean }>;
  rates: RateEntry[];
  adjustmentsByWorker: Map<string, Adjustment[]>;
  priorAmountsByWorker: Map<string, number[]>; // workerId -> prior 4 amounts KES
  firstWeekByWorker: Map<string, boolean>;
}): PayrollSheet {
  const lines: PayrollLine[] = [];
  let totalKgUnits = 0;
  let totalAmountCents = 0;
  let adjustmentsTotalCents = 0;
  let pickerCount = 0;

  for (const w of opts.workers) {
    const entries = opts.plucksByWorker.get(w.workerId) ?? [];
    const adj = opts.adjustmentsByWorker.get(w.workerId) ?? [];
    const prior = opts.priorAmountsByWorker.get(w.workerId) ?? [];
    const isFirst = opts.firstWeekByWorker.get(w.workerId) ?? false;

    // Only include workers who were active at any point in week OR have entries OR adjustments
    const wasActiveInWeek = opts.pluckingDays.some((pd) => isActiveOnPayroll(pd.date, w.employmentPeriods));
    // Also include if they have entries (fired mid-week case: entries before firing should still pay)
    const hasEntries = entries.length > 0;
    const hasAdj = adj.length > 0;
    if (!wasActiveInWeek && !hasEntries && !hasAdj) continue;

    const line = computePayrollLine({
      worker: w,
      entries,
      pluckingDays: opts.pluckingDays,
      rates: opts.rates,
      adjustmentsForThisWeek: adj,
      priorWeekAmounts: prior,
      isFirstWeek: isFirst,
    });

    // Skip lines with no kg and no adjustments unless they were active? But keep if active and present? For M6 we keep all active-in-week but with 0kg they still show daysWorked maybe 0. We'll include if they have any employment in week, even with 0kg, to show idle flag. But spec says payroll sheet per worker with amount, days worked, etc. We'll include if wasActiveInWeek.
    // However to avoid clutter, we include if they have at least one day where active, or entries, or adjustments.
    if (wasActiveInWeek || hasEntries || hasAdj) {
      lines.push(line);
      totalKgUnits += line.totalKgUnits;
      totalAmountCents += line.amountCents;
      adjustmentsTotalCents += line.adjustmentAmountCents;
      if (line.totalKgUnits > 0 || line.daysWorked > 0 || hasAdj) pickerCount++;
      // But grand total includes all lines, per spec sum of rounded worker amounts
    }
  }

  // Sort lines by total kg desc for display
  lines.sort((a, b) => b.totalKgUnits - a.totalKgUnits);

  return {
    farmId: opts.farmId,
    weekStart: opts.weekStart,
    weekEnd: opts.weekEnd,
    status: opts.status,
    lockedAt: opts.lockedAt,
    lines,
    totals: {
      totalKgUnits,
      totalKg: totalKgUnits / 10,
      totalAmountCents,
      totalAmountKes: Math.round(totalAmountCents / 100),
      pickerCount,
      adjustmentsTotalCents,
    },
    flags: { toleranceExceeded: false },
  };
}

export function payrollToCsv(sheet: PayrollSheet): string {
  const header = [
    "worker_id",
    "name",
    "phone_masked",
    "days_worked",
    "attendance_rate",
    "total_kg",
    "rate_kes_per_kg",
    "amount_kes",
    "flags",
    "adjustments_kes",
    "verified",
  ].join(",");
  const rows = sheet.lines.map((l) => {
    const rateKes = (l.rateCentsPerKg / 100).toFixed(2);
    const attn = l.attendanceRate !== null ? (l.attendanceRate * 100).toFixed(1) + "%" : "";
    const flags = `"${l.flags.join("; ").replace(/"/g, '""')}"`;
    return [
      l.workerId,
      `"${l.name.replace(/"/g, '""')}"`,
      l.maskedPhone,
      l.daysWorked,
      attn,
      l.totalKg,
      rateKes,
      l.amountKes,
      flags,
      l.adjustmentAmountKes,
      l.verified ? "yes" : "no",
    ].join(",");
  });
  const totalRow = [
    "TOTALS",
    "",
    "",
    "",
    "",
    sheet.totals.totalKg,
    "",
    sheet.totals.totalAmountKes,
    "",
    sheet.totals.adjustmentsTotalCents / 100,
    "",
  ].join(",");
  return [header, ...rows, totalRow].join("\n");
}

export function payrollToPrintableHtml(sheet: PayrollSheet, farmName: string): string {
  const rows = sheet.lines
    .map(
      (l) => `
    <tr>
      <td>${l.name}</td>
      <td>${l.maskedPhone}</td>
      <td style="text-align:center">${l.daysWorked}/${l.attendanceDenominator}</td>
      <td style="text-align:right">${l.totalKg.toFixed(1)}</td>
      <td style="text-align:right">${(l.rateCentsPerKg / 100).toFixed(2)}${l.rateBands.length > 1 ? ` (${l.rateBands.map((b) => `${(b.kgUnits / 10).toFixed(1)}kg@${(b.rateCentsPerKg / 100).toFixed(0)}`).join(", ")})` : ""}</td>
      <td style="text-align:right"><strong>${l.amountKes.toLocaleString()}</strong>${l.adjustments.length ? ` <span style="color:#6a5">+${l.adjustmentAmountKes} adj</span>` : ""}</td>
      <td style="font-size:11px">${l.flags.join("; ") || ""}</td>
    </tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Payroll ${sheet.weekStart} – ${farmName}</title>
<style>
  @media print { .no-print { display:none } body { font-size:12px } }
  body { font-family: system-ui, Arial, sans-serif; margin:24px; color:#111 }
  h1 { font-size:20px; margin:0 0 4px } h2 { font-size:14px; color:#555; margin:0 0 12px }
  table { width:100%; border-collapse:collapse; margin-top:12px }
  th { background:#1B4332; color:white; padding:8px; text-align:left; font-size:12px }
  td { padding:6px 8px; border-bottom:1px solid #ddd; font-size:12px }
  tfoot td { font-weight:800; background:#f5f5f0; border-top:2px solid #1B4332 }
  .badge { padding:2px 6px; border-radius:10px; font-size:11px; background:#eee }
  .locked { background:#e8f5e9; border:1px solid #a5d6a7; padding:6px 10px; border-radius:8px; display:inline-block }
  .open { background:#fff3e0; border:1px solid #ffcc80; padding:6px 10px; border-radius:8px; display:inline-block }
</style></head><body>
<h1>Tea Farm Ledger — Payroll Sheet</h1>
<h2>${farmName} · Week ${sheet.weekStart} to ${sheet.weekEnd} · <span class="${sheet.status === "locked" ? "locked" : "open"}">${sheet.status.toUpperCase()}${sheet.lockedAt ? " at " + new Date(sheet.lockedAt).toLocaleString() : ""}</span></h2>
<p style="font-size:12px;color:#555">Rate ${sheet.lines[0] ? (sheet.lines[0].rateCentsPerKg / 100).toFixed(2) : "9.00"} KES/kg (weighted if changed mid-week). Grand total is sum of rounded worker amounts. Use browser Print → Save as PDF.</p>
<table><thead><tr><th>Worker</th><th>Phone</th><th>Days</th><th style="text-align:right">Total kg</th><th style="text-align:right">Rate (weighted)</th><th style="text-align:right">Amount KES</th><th>Flags</th></tr></thead>
<tbody>${rows || `<tr><td colspan="7" style="text-align:center;color:#777">No active workers this week</td></tr>`}</tbody>
<tfoot><tr><td colspan="2">TOTALS · ${sheet.totals.pickerCount} pickers</td><td></td><td style="text-align:right">${sheet.totals.totalKg.toFixed(1)}</td><td></td><td style="text-align:right">KES ${sheet.totals.totalAmountKes.toLocaleString()}</td><td>${sheet.totals.adjustmentsTotalCents ? `incl. adjustments KES ${Math.round(sheet.totals.adjustmentsTotalCents / 100)}` : ""}</td></tr></tfoot></table>
<p style="font-size:11px;color:#777;margin-top:12px">Generated ${new Date().toLocaleString()} Africa/Nairobi · Append-only audit trail · Pay calculation: sum(kg × rate/date) → round half-up once per worker/week · CSV export available.</p>
<button class="no-print" onclick="window.print()" style="margin-top:12px;padding:10px 16px;background:#1B4332;color:white;border:0;border-radius:8;cursor:pointer">Print / Save as PDF</button>
<a class="no-print" href="?format=csv" style="margin-left:10px;font-size:13px">Download CSV</a>
</body></html>`;
}
