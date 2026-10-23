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
export function countSegments(text: string): number {
  if (text.length <= 160) return 1;
  return Math.ceil(text.length / 153);
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
    .map((line) => `${line.name} | ${(line.kgUnits / 10).toString()} | ${formatKes(estimateLinePayKes(line.kgUnits))}`);

  const body = [
    `Dear ${ownerName},`,
    "",
    "TEA FARM LEDGER",
    `${opts.dateLabel} DAILY SUMMARY`,
    `Rate: KES ${rateKes}/kg`,
    "",
    "NAME | KG | EST KES",
    ...rows,
    "--------------------",
    `TOTAL | ${totalKg} | ${formatKes(estimatedTotalKes)}`,
    "",
    "Thank you.",
  ].join("\n");

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
