export function getWeekStartMonday(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00+03:00");
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return toYMD(d);
}
export function getWeekEndSaturday(weekStartMonday: string): string {
  const d = new Date(weekStartMonday + "T12:00:00+03:00");
  d.setDate(d.getDate() + 5);
  return toYMD(d);
}
export function toYMD(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${day}`;
}
export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00+03:00");
  d.setDate(d.getDate() + days);
  return toYMD(d);
}
export function isMonday(dateStr: string): boolean {
  const d = new Date(dateStr + "T12:00:00+03:00");
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Nairobi", weekday: "short" }).format(d);
  return wd === "Mon";
}
export function weekRangeFromDate(dateStr: string): { start: string; end: string } {
  const start = getWeekStartMonday(dateStr);
  const end = getWeekEndSaturday(start);
  return { start, end };
}
export function isWeekLocked(weekEnd: string, submissionDate?: string | null): boolean {
  return !!submissionDate;
}
