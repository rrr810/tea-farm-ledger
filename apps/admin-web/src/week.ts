/** Calendar-only week helpers. All owner dashboard weeks follow Africa/Nairobi. */
export function eatIsoDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function currentWeekStartEAT(now = new Date()): string {
  const iso = eatIsoDate(now);
  const midnightUtc = new Date(`${iso}T00:00:00Z`);
  // Sunday 0 -> six days back; Monday 1 -> same date; Saturday 6 -> five back.
  const daysSinceMonday = (midnightUtc.getUTCDay() + 6) % 7;
  midnightUtc.setUTCDate(midnightUtc.getUTCDate() - daysSinceMonday);
  return midnightUtc.toISOString().slice(0, 10);
}
