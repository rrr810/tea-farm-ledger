/**
 * Employment periods — Decision 19 inclusive, 17 number reuse
 */

export type EmploymentPeriod = {
  id: string;
  worker_id: string;
  farm_id: string;
  start_date: string; // YYYY-MM-DD inclusive
  end_date: string | null; // inclusive, null = still active
  end_reason?: string;
};

export function isActiveOn(period: EmploymentPeriod, dateStr: string): boolean {
  if (dateStr < period.start_date) return false;
  if (period.end_date && dateStr > period.end_date) return false;
  return true;
}

export function getActivePeriod(periods: EmploymentPeriod[], dateStr: string): EmploymentPeriod | null {
  const sorted = [...periods].sort((a,b)=> a.start_date.localeCompare(b.start_date));
  for (const p of sorted) {
    if (isActiveOn(p, dateStr)) return p;
  }
  return null;
}

export function isCurrentlyActive(periods: EmploymentPeriod[]): boolean {
  return periods.some(p => p.end_date === null);
}

export function canHire(periods: EmploymentPeriod[], newStart: string): { ok: boolean; reason?: string } {
  // Cannot hire if already active
  if (isCurrentlyActive(periods)) return { ok: false, reason: "already active — end current period first" };
  // Also check overlapping inclusive dates: newStart must be after last end_date
  const lastEnded = periods.filter(p=> p.end_date !== null).sort((a,b)=> (a.end_date as string).localeCompare(b.end_date as string)).pop();
  if (lastEnded && newStart <= (lastEnded.end_date as string)) {
    return { ok: false, reason: `start ${newStart} must be after previous end ${lastEnded.end_date} (inclusive)` };
  }
  return { ok: true };
}

export function canFire(periods: EmploymentPeriod[], endDate: string): { ok: boolean; reason?: string } {
  const active = periods.find(p => p.end_date === null);
  if (!active) return { ok: false, reason: "no active period to end" };
  if (endDate < active.start_date) return { ok: false, reason: "end before start" };
  return { ok: true };
}

/**
 * Phone reuse rule: allowed for different worker only after previous holder is inactive,
 * with verification, full history, Admin notification.
 */
export function canReusePhone(phoneE164: string, existingWorkers: Array<{ worker_id: string; phone_e164: string | null; status: string }>, requestingWorkerId: string): { ok: boolean; reason?: string } {
  const holder = existingWorkers.find(w => w.phone_e164 === phoneE164 && w.status === "active" && w.worker_id !== requestingWorkerId);
  if (holder) return { ok: false, reason: `number belongs to active worker ${holder.worker_id}` };
  return { ok: true };
}
