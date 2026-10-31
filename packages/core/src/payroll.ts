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
  /** Set by persistence when a same-worker/day entry requires explicit review. */
  conflictFlag?: boolean;
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

function escapePrintableHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPrintableKg(kgUnits: number): string {
  const sign = kgUnits < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(kgUnits));
  return `${sign}${Math.trunc(absolute / 10)}.${absolute % 10}`;
}

function formatPrintableRate(centsPerKg: number): string {
  const sign = centsPerKg < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(centsPerKg));
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function printableFarmInitials(farmName: string): string {
  const initials = farmName
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return initials || "TL";
}

/**
 * A self-contained estate-quality payroll hard copy. It keeps the calculations
 * from the shared core untouched; presentation only formats stored integer
 * tenths/cents and gives the owner a clear Print → Save as PDF record.
 */
export function payrollToPrintableHtml(sheet: PayrollSheet, farmName: string): string {
  const safeFarmName = escapePrintableHtml(farmName);
  const rateBands = (line: PayrollLine) =>
    line.rateBands.length > 1
      ? `<small class="rate-bands">${line.rateBands
          .map((band) => `${formatPrintableKg(band.kgUnits)} kg @ KES ${formatPrintableRate(band.rateCentsPerKg)}`)
          .map(escapePrintableHtml)
          .join(" · ")}</small>`
      : "";
  const rows = sheet.lines
    .map(
      (line, index) => `
        <tr class="${index % 2 ? "stripe" : ""}">
          <td class="worker"><span class="row-no">${index + 1}</span>${escapePrintableHtml(line.name)}<small>${escapePrintableHtml(line.maskedPhone)}</small></td>
          <td class="center">${line.daysWorked}/${line.attendanceDenominator}</td>
          <td class="numeric">${formatPrintableKg(line.totalKgUnits)}</td>
          <td class="numeric">KES ${formatPrintableRate(line.rateCentsPerKg)}${rateBands(line)}</td>
          <td class="numeric amount">KES ${line.amountKes.toLocaleString()}${line.adjustments.length ? `<small>incl. adjustment KES ${line.adjustmentAmountKes.toLocaleString()}</small>` : ""}</td>
          <td class="flags">${line.flags.length ? line.flags.map((flag) => `<span>${escapePrintableHtml(flag)}</span>`).join("") : "—"}</td>
        </tr>`,
    )
    .join("");
  const statusCopy = sheet.status === "locked" ? "Final locked record" : sheet.status === "incomplete" ? "Incomplete — review before finalising" : "Live estimate";
  const lockedAt = sheet.lockedAt ? ` · locked ${escapePrintableHtml(sheet.lockedAt)}` : "";
  const initials = printableFarmInitials(farmName);
  const farmCode = escapePrintableHtml(sheet.farmId.slice(0, 8).toUpperCase());
  const generatedAt = escapePrintableHtml(new Date().toLocaleString("en-GB", { timeZone: "Africa/Nairobi" }));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Payroll Sheet ${escapePrintableHtml(sheet.weekStart)} — ${safeFarmName}</title>
<style>
  :root { --forest:#153d2b; --tea:#2c6a45; --copper:#bb743d; --ink:#1d2921; --paper:#fffdf7; --mist:#f1eee4; --line:#d9d2c0; --muted:#617066; }
  * { box-sizing:border-box; }
  @page { size:A4 landscape; margin:11mm; }
  body { margin:0; color:var(--ink); background:var(--paper); font-family:"Aptos", "Segoe UI", Arial, sans-serif; font-size:11px; }
  .sheet { max-width:1120px; margin:0 auto; }
  .masthead { display:grid; grid-template-columns:58px 1fr auto; gap:14px; align-items:center; border-top:8px solid var(--forest); padding:16px 0 13px; border-bottom:1px solid var(--line); }
  .crest { width:52px; height:52px; border-radius:50%; display:grid; place-items:center; color:#fff; background:var(--forest); border:3px solid #d9b47d; font:700 17px Georgia, serif; letter-spacing:.8px; box-shadow:inset 0 0 0 2px #224f39; }
  .eyebrow { color:var(--copper); font-weight:800; letter-spacing:1.55px; text-transform:uppercase; font-size:9px; margin-bottom:3px; }
  h1 { margin:0; font:700 24px Georgia, "Times New Roman", serif; letter-spacing:.1px; color:var(--forest); }
  .subtitle { margin:4px 0 0; color:var(--muted); font-size:11px; }
  .record-chip { align-self:start; text-align:right; font-size:9px; color:var(--muted); line-height:1.5; }
  .record-chip strong { display:block; color:var(--forest); letter-spacing:.8px; font-size:10px; text-transform:uppercase; }
  .summary { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; border:1px solid var(--line); margin:15px 0 12px; background:#faf8f1; }
  .summary div { padding:9px 12px; border-right:1px solid var(--line); }
  .summary div:last-child { border-right:0; }
  .summary small { display:block; font-size:8px; text-transform:uppercase; letter-spacing:1px; color:var(--muted); font-weight:700; margin-bottom:2px; }
  .summary strong { color:var(--forest); font:700 15px Georgia, serif; }
  .notice { margin:0 0 11px; padding:8px 10px; border-left:4px solid var(--copper); color:#5e5144; background:#faf5ea; line-height:1.35; }
  table { border-collapse:collapse; width:100%; table-layout:fixed; border:1px solid var(--line); }
  th { background:var(--forest); color:#fff; padding:8px 6px; text-align:left; font-size:9px; letter-spacing:.25px; }
  th:first-child { width:25%; padding-left:11px; } th:nth-child(2) { width:10%; text-align:center; } th:nth-child(3) { width:11%; text-align:right; } th:nth-child(4) { width:18%; text-align:right; } th:nth-child(5) { width:18%; text-align:right; } th:last-child { width:18%; background:#0e3021; }
  td { border-top:1px solid var(--line); padding:7px 6px; vertical-align:middle; font-variant-numeric:tabular-nums; }
  tbody tr.stripe { background:#fbfaf5; }
  td.worker { font-weight:650; padding-left:10px; } td.worker small { display:block; padding-left:22px; margin-top:2px; color:#6f776f; font-size:8px; font-weight:500; }
  .row-no { color:var(--copper); display:inline-block; width:22px; font-size:9px; font-weight:800; }
  .center { text-align:center; } .numeric { text-align:right; white-space:nowrap; } .amount { font-weight:800; color:var(--forest); } .numeric small { display:block; color:#687369; font-size:8px; font-weight:500; margin-top:2px; white-space:normal; }
  .rate-bands { display:block; color:#687369; font-size:8px; font-weight:500; line-height:1.35; margin-top:2px; white-space:normal; }
  .flags { font-size:8px; color:#5e5548; line-height:1.3; } .flags span { display:block; margin-bottom:2px; }
  tfoot td { background:#e7ede5; border-top:2px solid var(--forest); color:var(--forest); font-weight:800; } tfoot td:first-child { padding-left:10px; font-size:9px; letter-spacing:.45px; text-transform:uppercase; }
  .note { margin:10px 0 15px; color:var(--muted); font-size:9px; line-height:1.55; } .note b { color:var(--forest); }
  .signatures { display:grid; grid-template-columns:1fr 1fr; gap:44px; margin:24px 24px 0; } .signature { border-top:1px solid #797970; padding-top:5px; color:#5e655d; font-size:9px; }
  footer { border-top:1px solid var(--line); display:flex; justify-content:space-between; gap:12px; margin-top:16px; padding-top:8px; color:var(--muted); font-size:8px; }
  button { border:0; cursor:pointer; background:var(--forest); color:#fff; padding:9px 12px; border-radius:4px; font-weight:700; } .print-tools { margin:14px 0; display:flex; gap:10px; align-items:center; } .print-tools a { color:var(--forest); font-weight:700; font-size:11px; }
  @media print { body { background:#fff; } .no-print { display:none !important; } .sheet { max-width:none; } }
</style></head><body><main class="sheet">
<header class="masthead"><div class="crest">${escapePrintableHtml(initials)}</div><div><div class="eyebrow">Tea Ledger · Estate Payroll Record</div><h1>Payroll Sheet</h1><p class="subtitle">${safeFarmName} · Week ${escapePrintableHtml(sheet.weekStart)} to ${escapePrintableHtml(sheet.weekEnd)}</p></div><div class="record-chip"><strong>${escapePrintableHtml(statusCopy)}</strong>Farm record ${farmCode}${lockedAt}</div></header>
<section class="summary"><div><small>Farm kilograms</small><strong>${formatPrintableKg(sheet.totals.totalKgUnits)} kg</strong></div><div><small>Payroll total</small><strong>KES ${sheet.totals.totalAmountKes.toLocaleString()}</strong></div><div><small>Workers counted</small><strong>${sheet.totals.pickerCount}</strong></div><div><small>Week status</small><strong>${escapePrintableHtml(sheet.status.toUpperCase())}</strong></div></section>
<div class="notice"><strong>Payroll basis.</strong> Each worker’s pay uses the rate in force on each recorded date, then rounds half-up once for that worker. The farm payroll total is the sum of those worker amounts. ${sheet.status === "locked" ? "This is the locked historical record." : "This is a live estimate until server completion controls final payroll."}</div>
<table aria-label="Payroll Sheet"><thead><tr><th>Worker</th><th>Days</th><th>Total kg</th><th>Rate / kg</th><th>Amount</th><th>Checks</th></tr></thead><tbody>${rows || `<tr><td colspan="6" style="color:#697269;padding:24px;text-align:center">No active workers in this farm record for this week.</td></tr>`}</tbody><tfoot><tr><td colspan="2">Payroll totals · ${sheet.totals.pickerCount} pickers</td><td class="numeric">${formatPrintableKg(sheet.totals.totalKgUnits)}</td><td></td><td class="numeric">KES ${sheet.totals.totalAmountKes.toLocaleString()}</td><td>${sheet.totals.adjustmentsTotalCents ? `includes adjustments KES ${Math.round(sheet.totals.adjustmentsTotalCents / 100).toLocaleString()}` : ""}</td></tr></tfoot></table>
<p class="note"><b>Record note:</b> weights are stored in 0.1 kg units; any worker checks are displayed above for review. This printable report does not create a payment or alter the append-only farm history.</p>
<div class="signatures"><div class="signature">Supervisor signature &amp; date</div><div class="signature">Owner / manager signature &amp; date</div></div>
<footer><span>Generated ${generatedAt} · Africa/Nairobi</span><span>Tea Ledger · Server-authoritative farm record · Print landscape / Save as PDF</span></footer>
<div class="print-tools no-print"><button onclick="window.print()">Print / Save as PDF</button><a href="?format=csv">Download CSV</a></div>
</main></body></html>`;
}
