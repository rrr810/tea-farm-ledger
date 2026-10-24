export type OutboxType = { type: string };

/** A per-farm local pointer to the sheet the supervisor should open next. */
export function activeDateStorageKey(farmId: string): string {
  return `active_date:${farmId}`;
}

/** ISO calendar-day arithmetic; 12:00 avoids a local-time rollover while adding days. */
export function nextCalendarDate(date: string): string {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + 1);
  return value.toISOString().slice(0, 10);
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
