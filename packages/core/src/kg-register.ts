import { isActiveOnPayroll, type PluckEntry, type WorkerInfo } from "./payroll.js";

/**
 * Server-authoritative weekly leaf register. All stored weight values remain
 * integer tenths of a kilogram; formatting is deliberately string-based so the
 * printable record never rounds a field value through floating point.
 */
export type WeeklyKgRegisterCellState =
  | "recorded"
  | "absent"
  | "no-plucking"
  | "not-employed"
  | "blank"
  | "conflict";

export type WeeklyKgRegisterCell = {
  state: WeeklyKgRegisterCellState;
  kgUnits: number | null;
  /** Human-readable paper/CSV token: 34.3, A, NP, —, or 34.3*. */
  label: string;
};

export type WeeklyKgRegisterDay = {
  date: string;
  shortLabel: string;
  isPluckingDay: boolean;
  totalKgUnits: number;
  totalLabel: string;
};

export type WeeklyKgRegisterRow = {
  workerId: string;
  name: string;
  cells: WeeklyKgRegisterCell[];
  totalKgUnits: number;
  totalLabel: string;
};

export type WeeklyKgRegister = {
  farmId: string;
  weekStart: string;
  weekEnd: string;
  status: "open" | "locked" | "incomplete";
  lockedAt: string | null;
  days: WeeklyKgRegisterDay[];
  rows: WeeklyKgRegisterRow[];
  totals: {
    totalKgUnits: number;
    totalLabel: string;
    workerCount: number;
  };
  /** Multiple entries or a conflict flag are surfaced, never selected silently. */
  hasConflicts: boolean;
};

export function formatKgUnits(kgUnits: number): string {
  const sign = kgUnits < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(kgUnits));
  return `${sign}${Math.trunc(absolute / 10)}.${absolute % 10}`;
}

function dayLabel(date: string, index: number): string {
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${names[index] ?? "Day"} ${Number(date.slice(8, 10))}`;
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatLongDate(date: string): string {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${Number(date.slice(8, 10))} ${months[Number(date.slice(5, 7)) - 1] ?? ""} ${date.slice(0, 4)}`;
}

function statusLabel(status: WeeklyKgRegister["status"]): string {
  if (status === "locked") return "Final locked record";
  if (status === "incomplete") return "Incomplete — review before payroll";
  return "Live operational record";
}

function brandInitials(farmName: string): string {
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
 * Builds one Monday–Saturday ledger from the same normalized payroll inputs.
 * A duplicate/conflicted daily entry remains visible with an asterisk and its
 * recorded sum; the report deliberately does not invent a winning entry.
 */
export function computeWeeklyKgRegister(opts: {
  farmId: string;
  weekStart: string;
  weekEnd: string;
  status: "open" | "locked" | "incomplete";
  lockedAt: string | null;
  workers: WorkerInfo[];
  plucksByWorker: Map<string, PluckEntry[]>;
  pluckingDays: Array<{ date: string; isPluckingDay: boolean }>;
}): WeeklyKgRegister {
  const days = opts.pluckingDays.map((day, index) => ({
    date: day.date,
    shortLabel: dayLabel(day.date, index),
    isPluckingDay: day.isPluckingDay,
    totalKgUnits: 0,
    totalLabel: "0.0",
  }));
  const rows: WeeklyKgRegisterRow[] = [];
  let hasConflicts = false;

  for (const worker of opts.workers) {
    const entries = opts.plucksByWorker.get(worker.workerId) ?? [];
    const activeInWeek = days.some((day) => isActiveOnPayroll(day.date, worker.employmentPeriods));
    if (!activeInWeek && entries.length === 0) continue;

    let totalKgUnits = 0;
    const cells = days.map((day, index): WeeklyKgRegisterCell => {
      const active = isActiveOnPayroll(day.date, worker.employmentPeriods);
      if (!active) return { state: "not-employed", kgUnits: null, label: "—" };
      if (!day.isPluckingDay) return { state: "no-plucking", kgUnits: null, label: "NP" };

      const matching = entries.filter((entry) => entry.businessDate === day.date);
      if (matching.length === 0) return { state: "blank", kgUnits: null, label: "—" };

      const hasConflict = matching.length > 1 || matching.some((entry) => entry.conflictFlag === true);
      const presentEntries = matching.filter((entry) => entry.present);
      if (presentEntries.length === 0) {
        if (hasConflict) hasConflicts = true;
        return { state: hasConflict ? "conflict" : "absent", kgUnits: null, label: hasConflict ? "A*" : "A" };
      }

      const kgUnits = presentEntries.reduce((sum, entry) => sum + (entry.kgUnits ?? 0), 0);
      totalKgUnits += kgUnits;
      days[index]!.totalKgUnits += kgUnits;
      if (hasConflict) hasConflicts = true;
      return {
        state: hasConflict ? "conflict" : "recorded",
        kgUnits,
        label: `${formatKgUnits(kgUnits)}${hasConflict ? "*" : ""}`,
      };
    });

    rows.push({
      workerId: worker.workerId,
      name: worker.fullName,
      cells,
      totalKgUnits,
      totalLabel: formatKgUnits(totalKgUnits),
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const day of days) day.totalLabel = formatKgUnits(day.totalKgUnits);
  const totalKgUnits = days.reduce((sum, day) => sum + day.totalKgUnits, 0);

  return {
    farmId: opts.farmId,
    weekStart: opts.weekStart,
    weekEnd: opts.weekEnd,
    status: opts.status,
    lockedAt: opts.lockedAt,
    days,
    rows,
    totals: {
      totalKgUnits,
      totalLabel: formatKgUnits(totalKgUnits),
      workerCount: rows.length,
    },
    hasConflicts,
  };
}

/** Spreadsheet-friendly row register with A / NP / — legend preserved. */
export function weeklyKgRegisterToCsv(register: WeeklyKgRegister): string {
  const header = ["worker_id", "worker", ...register.days.map((day) => `${day.shortLabel} (${day.date})`), "week_total_kg"];
  const rows = register.rows.map((row) => [
    row.workerId,
    row.name,
    ...row.cells.map((cell) => cell.label),
    row.totalLabel,
  ]);
  const totals = ["", "DAILY TOTALS", ...register.days.map((day) => day.totalLabel), register.totals.totalLabel];
  return [header, ...rows, totals].map((row) => row.map((value) => csvField(String(value))).join(",")).join("\n");
}

/** Branded, landscape-A4, self-contained HTML for browser Print → Save as PDF. */
export function weeklyKgRegisterToPrintableHtml(
  register: WeeklyKgRegister,
  farmName: string,
  generatedAt = new Date().toLocaleString("en-GB", { timeZone: "Africa/Nairobi" }),
): string {
  const cells = (row: WeeklyKgRegisterRow) =>
    row.cells
      .map(
        (cell) => `<td class="cell-${cell.state}" title="${escapeHtml(cell.state)}">${escapeHtml(cell.label)}</td>`,
      )
      .join("");
  const rows = register.rows
    .map(
      (row, index) => `<tr class="${index % 2 ? "stripe" : ""}"><td class="worker"><span class="row-no">${index + 1}</span>${escapeHtml(row.name)}</td>${cells(row)}<td class="week-total">${escapeHtml(row.totalLabel)}</td></tr>`,
    )
    .join("");
  const headers = register.days
    .map((day) => `<th>${escapeHtml(day.shortLabel)}<small>${day.isPluckingDay ? day.date : "No plucking"}</small></th>`)
    .join("");
  const dayTotals = register.days.map((day) => `<td>${escapeHtml(day.totalLabel)}</td>`).join("");
  const conflictNotice = register.hasConflicts
    ? `<div class="alert"><strong>Review required.</strong> Asterisked cells contain more than one recorded entry or a flagged conflict. Their recorded sum is shown; this report has not chosen or overwritten an entry.</div>`
    : "";
  const lockedAt = register.lockedAt ? ` · locked ${escapeHtml(register.lockedAt)}` : "";
  const initials = brandInitials(farmName);
  const safeFarmName = escapeHtml(farmName);
  const farmCode = escapeHtml(register.farmId.slice(0, 8).toUpperCase());

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Weekly Leaf Register ${escapeHtml(register.weekStart)} — ${safeFarmName}</title>
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
  .summary { display:grid; grid-template-columns:1fr 1fr 1fr; border:1px solid var(--line); margin:15px 0 12px; background:#faf8f1; }
  .summary div { padding:9px 12px; border-right:1px solid var(--line); }
  .summary div:last-child { border-right:0; }
  .summary small { display:block; font-size:8px; text-transform:uppercase; letter-spacing:1px; color:var(--muted); font-weight:700; margin-bottom:2px; }
  .summary strong { color:var(--forest); font:700 15px Georgia, serif; }
  .alert { margin:0 0 11px; padding:8px 10px; border-left:4px solid #a35d22; color:#673713; background:#fff4e7; line-height:1.35; }
  table { border-collapse:collapse; width:100%; table-layout:fixed; border:1px solid var(--line); }
  th { background:var(--forest); color:#fff; padding:8px 5px; text-align:center; font-size:9px; letter-spacing:.25px; }
  th:first-child { width:29%; text-align:left; padding-left:11px; }
  th:last-child { width:12%; background:#0e3021; }
  th small { display:block; font-weight:400; font-size:7px; opacity:.77; margin-top:3px; letter-spacing:0; }
  td { border-top:1px solid var(--line); padding:7px 5px; text-align:center; vertical-align:middle; font-variant-numeric:tabular-nums; }
  tbody tr.stripe { background:#fbfaf5; }
  td.worker { text-align:left; font-weight:650; padding-left:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .row-no { color:var(--copper); display:inline-block; width:22px; font-size:9px; font-weight:800; }
  .cell-no-plucking { color:#77766f; font-weight:700; background:#f0efe9; }
  .cell-absent { color:#936022; font-weight:700; background:#fff9ee; }
  .cell-not-employed, .cell-blank { color:#9a9a91; }
  .cell-conflict { color:#8b2b1c; font-weight:800; background:#fff0ec; }
  .week-total { color:var(--forest); font-weight:800; background:#f2f6f0; }
  tfoot td { background:#e7ede5; border-top:2px solid var(--forest); color:var(--forest); font-weight:800; }
  tfoot td:first-child { text-align:left; padding-left:10px; font-size:9px; letter-spacing:.45px; text-transform:uppercase; }
  .legend { margin:10px 0 15px; color:var(--muted); font-size:9px; line-height:1.55; }
  .legend b { color:var(--forest); }
  .signatures { display:grid; grid-template-columns:1fr 1fr; gap:44px; margin:24px 24px 0; }
  .signature { border-top:1px solid #797970; padding-top:5px; color:#5e655d; font-size:9px; }
  footer { border-top:1px solid var(--line); display:flex; justify-content:space-between; gap:12px; margin-top:16px; padding-top:8px; color:var(--muted); font-size:8px; }
  button { border:0; cursor:pointer; background:var(--forest); color:#fff; padding:9px 12px; border-radius:4px; font-weight:700; }
  .print-tools { margin:14px 0; display:flex; gap:10px; align-items:center; }
  .print-tools a { color:var(--forest); font-weight:700; font-size:11px; }
  @media print { body { background:#fff; } .no-print { display:none !important; } .sheet { max-width:none; } }
</style></head><body><main class="sheet">
<header class="masthead"><div class="crest">${escapeHtml(initials)}</div><div><div class="eyebrow">Tea Ledger · Estate Field Record</div><h1>Weekly Leaf Register</h1><p class="subtitle">${safeFarmName} · Week of ${escapeHtml(formatLongDate(register.weekStart))} to ${escapeHtml(formatLongDate(register.weekEnd))}</p></div><div class="record-chip"><strong>${escapeHtml(statusLabel(register.status))}</strong>Farm record ${farmCode}${lockedAt}</div></header>
<section class="summary"><div><small>Farm total</small><strong>${escapeHtml(register.totals.totalLabel)} kg</strong></div><div><small>Registered workers</small><strong>${register.totals.workerCount}</strong></div><div><small>Week status</small><strong>${escapeHtml(register.status.toUpperCase())}</strong></div></section>
${conflictNotice}
<table aria-label="Weekly kilograms register"><thead><tr><th>Worker</th>${headers}<th>Week total<br><small>kg</small></th></tr></thead><tbody>${rows || `<tr><td colspan="8" style="color:#697269;padding:24px">No workers were active in this farm record for this week.</td></tr>`}</tbody><tfoot><tr><td>Daily total · kg</td>${dayTotals}<td>${escapeHtml(register.totals.totalLabel)}</td></tr></tfoot></table>
<p class="legend"><b>Legend:</b> A = absent · NP = no plucking day · — = no record / not employed that day · * = conflict requires review. All weights are recorded in 0.1 kg units. This report is a farm-specific operational record; it does not alter append-only history.</p>
<div class="signatures"><div class="signature">Supervisor signature &amp; date</div><div class="signature">Owner / manager signature &amp; date</div></div>
<footer><span>Generated ${escapeHtml(generatedAt)} · Africa/Nairobi</span><span>Tea Ledger · Server-authoritative farm record · Print landscape / Save as PDF</span></footer>
<div class="print-tools no-print"><button onclick="window.print()">Print / Save as PDF</button><a href="?format=csv">Download CSV</a></div>
</main></body></html>`;
}
