export type OutboxType = { type: string };

/** A per-farm local pointer to the sheet the supervisor should open next. */
export function activeDateStorageKey(farmId: string): string {
  return `active_date:${farmId}`;
}

/**
 * Per-farm, per-Saturday local hand-off state. This never asserts that the
 * cloud lock exists on its own: it is set to confirmed only after a successful
 * sync response containing the queued FINAL event.
 */
export function saturdayFinalStorageKey(farmId: string, saturday: string): string {
  return `saturday_final:${farmId}:${saturday}`;
}

/** ISO calendar-day arithmetic; 12:00 avoids a local-time rollover while adding days. */
export function nextCalendarDate(date: string): string {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + 1);
  return value.toISOString().slice(0, 10);
}

/** Date-only business values are interpreted in Africa/Nairobi. */
export function isSaturdayEAT(date: string): boolean {
  // 09:00 UTC is noon in Nairobi, so it stays within the supplied business day.
  return new Date(`${date}T09:00:00Z`).getUTCDay() === 6;
}

/** Sunday is not an operating sheet: a successful Saturday FINAL opens Monday. */
export function nextOperationalDate(date: string): string {
  const next = nextCalendarDate(date);
  return isSaturdayEAT(date) ? nextCalendarDate(next) : next;
}

export type SaturdayFinalGate =
  | "not-saturday"
  | "saturday-not-done"
  | "queued"
  | "confirmed"
  | "ready";

/**
 * The client-side control is intentionally restrictive. The API repeats the
 * Saturday/Done check so a stale or modified client cannot lock a pay week.
 */
export function saturdayFinalGate(input: {
  date: string;
  dayDone: boolean;
  submissionState: "idle" | "queued" | "confirmed";
}): SaturdayFinalGate {
  if (!isSaturdayEAT(input.date)) return "not-saturday";
  if (!input.dayDone) return "saturday-not-done";
  if (input.submissionState === "queued") return "queued";
  if (input.submissionState === "confirmed") return "confirmed";
  return "ready";
}

export type OrderedOutboxItem = {
  type: string;
  createdAt: string;
};

/**
 * Dexie's primary key is a random UUID, not insertion order. Send FINAL last
 * even if a device's table enumeration is arbitrary, so the Saturday
 * completion batch always reaches the API before it can request a week lock.
 */
export function orderOutboxForSync<T extends OrderedOutboxItem>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftIsFinal = left.item.type === "week.submitted";
      const rightIsFinal = right.item.type === "week.submitted";
      if (leftIsFinal !== rightIsFinal) return leftIsFinal ? 1 : -1;
      const createdAtOrder = left.item.createdAt.localeCompare(right.item.createdAt);
      return createdAtOrder || left.index - right.index;
    })
    .map(({ item }) => item);
}

/**
 * Recover users of the old PWA shell that wrote the done marker but did not
 * persist the auto-opened next-day pointer. Only a completed *today* needs
 * migration; old historical days must remain historical and locked.
 */
export function recoverActiveDate(input: {
  farmId: string;
  savedActiveDate: string | null;
  today: string;
  isDateDone: (date: string) => boolean;
  /** Return false when a completed sheet must remain on screen for review. */
  canAdvancePastDate?: (date: string) => boolean;
}): string {
  if (!input.farmId) return input.today;

  // An older in-memory auto-roll could leave a pointer at the day that was
  // subsequently marked Done. Never trust a saved pointer to a closed sheet:
  // advance through any contiguous completed dates until we reach the fresh
  // sheet. With no saved pointer we begin at today, preserving the original
  // one-time migration for old shells that completed today.
  let date = input.savedActiveDate ?? input.today;
  while (
    input.isDateDone(date) &&
    (input.canAdvancePastDate?.(date) ?? true)
  ) {
    date = nextOperationalDate(date);
  }
  return date;
}

/**
 * Worker/employment changes are safe to sync immediately when online.
 * Kg entries remain local until the day's explicit confirmation, which queues
 * day.confirmed alongside the complete set of pluck events.
 */
export function shouldAutoSyncOutbox(items: readonly OutboxType[]): boolean {
  return items.some(({ type }) => (
    type === "worker.registered" ||
    type === "employment.started" ||
    type === "employment.ended" ||
    type === "day.confirmed" ||
    type === "day.plucking_set" ||
    type === "week.submitted"
  ));
}
