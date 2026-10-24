export const GSM7_REGEX = /^[@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà]*$/;
export function isGsm7(text: string): boolean {
  if (/[“”‘’—–•…€]/.test(text)) return false;
  if (/[\uD800-\uDFFF]/.test(text)) return false;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code > 126) return false;
  }
  return true;
}
// GSM-7 extension-table symbols consume two septets even though they are one
// JavaScript character. Count them correctly so the unit/cost guard is honest.
const GSM7_EXTENSION_CHARS = new Set(["^", "{", "}", "\\", "[", "~", "]", "|"]);
function gsm7SeptetLength(text: string): number {
  return [...text].reduce((total, char) => total + (GSM7_EXTENSION_CHARS.has(char) ? 2 : 1), 0);
}
export function countSegments(text: string): number {
  const length = isGsm7(text) ? gsm7SeptetLength(text) : text.length;
  if (length <= 160) return 1;
  return Math.ceil(length / 153);
}
export function fitsInSegments(text: string, maxSegments: number): boolean {
  return countSegments(text) <= maxSegments;
}
export type DailyToken = string;
export function formatDailyTokens(tokens: Record<string, DailyToken>): string {
  const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return order.map((d) => `${d}${tokens[d] ?? "?"}`).join(" ");
}
export function buildWeeklyReceiptSms(opts: {
  workerName: string;
  tokens: Record<string, DailyToken>;
  totalKgUnits: number;
  rateCentsPerKg: number;
  amountKes: number;
  weekLabel?: string;
}): { body: string; segments: number; gsm7: boolean } {
  const totalKg = (opts.totalKgUnits / 10).toString();
  const rateKes = (opts.rateCentsPerKg / 100).toString();
  const prefix = opts.weekLabel ? `${opts.weekLabel} ${opts.workerName}: ` : `${opts.workerName}: `;
  const tokensStr = formatDailyTokens(opts.tokens);
  const body = `${prefix}${tokensStr} = ${totalKg}kg x KES${rateKes} = KES${opts.amountKes}. Wrong? Tell supervisor by Sun.`;
  return { body, segments: countSegments(body), gsm7: isGsm7(body) };
}
export function buildDailySms(opts: {
  /** Display name for the farm owner. The scheduler supplies Peter Rugut for this farm. */
  ownerName?: string;
  dateLabel: string;
  totalKgUnits: number;
  pickerCount: number;
  /** One entry for every picker recorded for the day. */
  lines: Array<{ name: string; kgUnits: number }>;
  rateCentsPerKg: number;
  totalPayEstimateKes?: number;
}): { body: string; segments: number; gsm7: boolean } {
  const totalKg = (opts.totalKgUnits / 10).toString();
  const rateKes = (opts.rateCentsPerKg / 100).toString();
  const ownerName = opts.ownerName?.trim() || "Farm Owner";
  const formatKes = (amount: number) => Math.round(amount).toLocaleString("en-KE");
  const estimateLinePayKes = (kgUnits: number) => Math.round((kgUnits * opts.rateCentsPerKg) / 1000);
  const estimatedTotalKes = opts.totalPayEstimateKes ?? estimateLinePayKes(opts.totalKgUnits);

  // Alphabetical order is stable and lets Peter find each worker quickly. The rate is
  // shown once because it applies to every row; repeating it per worker wastes parts.
  const rows = [...opts.lines]
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    // Use hyphens, not pipes: | is GSM-7 extension-table text and costs an
    // extra septet per occurrence. The compact table is friendlier to the budget.
    .map((line) => `${line.name} - ${(line.kgUnits / 10).toString()} - ${formatKes(estimateLinePayKes(line.kgUnits))}`);

  const body = [
    `Dear ${ownerName},`,
    "",
    "TEA FARM LEDGER",
    `${opts.dateLabel} DAILY SUMMARY`,
    `Rate: KES ${rateKes}/kg`,
    "",
    "NAME - KG - EST KES",
    ...rows,
    "--------------------",
    `TOTAL - ${totalKg} - ${formatKes(estimatedTotalKes)}`,
    "",
    "Thank you.",
  ].join("\n");

  return { body, segments: countSegments(body), gsm7: isGsm7(body) };
}
function compactSmsText(value: string, maxLength: number): string {
  // Daily notifications are deliberately GSM-7/ASCII so a pasted emoji, curly
  // quote, or long no-plucking reason does not silently increase the SMS bill.
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function kgText(kgUnits: number): string {
  return (kgUnits / 10).toFixed(1);
}

/** A concise, individual daily kg/pay notification for a consented picker. */
export function buildDailyWorkerSms(opts: {
  dateLabel: string;
  kgUnits: number;
  amountKes: number;
}): { body: string; segments: number; gsm7: boolean } {
  const body = `Tea Ledger ${compactSmsText(opts.dateLabel, 18)}: ${kgText(opts.kgUnits)}kg, estimated pay KES ${Math.round(opts.amountKes)}.`;
  return { body, segments: countSegments(body), gsm7: isGsm7(body) };
}

/** Transparent status when a consented picker has no payable entry on a completed day. */
export function buildDailyAbsentSms(opts: {
  dateLabel: string;
}): { body: string; segments: number; gsm7: boolean } {
  const body = `Tea Ledger ${compactSmsText(opts.dateLabel, 18)}: no kg or pay recorded today.`;
  return { body, segments: countSegments(body), gsm7: isGsm7(body) };
}

/**
 * Owner/Peter daily summary designed to fit one GSM-7 part for the current small
 * farm while still naming every recorded picker. The actual segment count is
 * returned and stored; more workers may naturally require more than one part.
 */
export function buildCompactDailyOwnerSms(opts: {
  dateLabel: string;
  totalKgUnits: number;
  pickerCount: number;
  totalPayEstimateKes: number;
  lines: Array<{ name: string; kgUnits: number; amountKes: number }>;
}): { body: string; segments: number; gsm7: boolean } {
  const rows = [...opts.lines]
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    .map((line) => `${compactSmsText(line.name, 22)} ${kgText(line.kgUnits)}kg/KES${Math.round(line.amountKes)}`)
    .join("; ");
  const summary = `Tea Ledger ${compactSmsText(opts.dateLabel, 18)}: ${opts.pickerCount} pickers, ${kgText(opts.totalKgUnits)}kg, estimated KES${Math.round(opts.totalPayEstimateKes)}.`;
  const body = rows ? `${summary} ${rows}.` : summary;
  return { body, segments: countSegments(body), gsm7: isGsm7(body) };
}

/** Shared no-plucking notification for both the owner summary and consented workers. */
export function buildDailyNoPluckingSms(opts: {
  dateLabel: string;
  reason: string;
}): { body: string; segments: number; gsm7: boolean } {
  const reason = compactSmsText(opts.reason, 72) || "not recorded";
  const body = `Tea Ledger ${compactSmsText(opts.dateLabel, 18)}: no plucking today. Reason: ${reason}.`;
  return { body, segments: countSegments(body), gsm7: isGsm7(body) };
}

export function buildFridayEstimateSms(opts: {
  dateLabel: string;
  totalKgUnits: number;
  estPayKes: number;
}): { body: string; segments: number; gsm7: boolean } {
  const totalKg = (opts.totalKgUnits / 10).toString();
  const body = `TEA ${opts.dateLabel} week so far ${totalKg}kg. Est pay KES ${opts.estPayKes} (Mon-Fri). Sat adds more. Keep balance ready.`;
  return { body, segments: countSegments(body), gsm7: isGsm7(body) };
}
export function buildNoPluckingSms(opts: { dateLabel: string; reason: string }): { body: string; segments: number; gsm7: boolean } {
  const body = `TEA ${opts.dateLabel}: No plucking today - ${opts.reason}.`;
  return { body, segments: countSegments(body), gsm7: isGsm7(body) };
}
export function buildSupervisorReminderSms(): { body: string; segments: number; gsm7: boolean } {
  const body = "Saturday entry not received by server, please connect to sync.";
  return { body, segments: countSegments(body), gsm7: isGsm7(body) };
}
export function buildVerificationSms(opts: { code: string; farmName: string }): { body: string; segments: number; gsm7: boolean } {
  const body = `Code ${opts.code} to confirm your M-Pesa number for pay at ${opts.farmName}. Ignore if not you.`;
  return { body, segments: countSegments(body), gsm7: isGsm7(body) };
}
