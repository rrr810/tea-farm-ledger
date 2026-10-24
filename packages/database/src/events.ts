import { randomUUID } from "node:crypto";
import { normalizeKePhone, type LedgerEvent } from "@tea-ledger/core";
import { getDb } from "./db.js";

export type PushResult = {
  accepted: number;
  /** IDs newly written by this request; callers may safely run post-sync effects only for these. */
  acceptedEventIds: string[];
  duplicates: number;
  flaggedAsCorrection: number;
  conflicts: number;
};

type WorkerProjectionTarget = { farmId: string; workerId: string };
type WorkerEventRow = {
  event_id: string;
  event_type: string;
  payload: unknown;
  business_date: string | Date;
  seq: number;
  conflict_flag: boolean;
};

type WorkerRow = {
  worker_id: string;
  farm_id: string;
  full_name: string;
  phone_e164: string | null;
};

const WORKER_PROJECTION_EVENTS = new Set([
  "worker.registered",
  "employment.started",
  "employment.ended",
]);

/**
 * Store immutable events first, then materialize the worker and employment
 * read-models that the Admin and payroll views query. The PWA can sync its
 * registration/start events in either order, so projection happens after the
 * whole batch has been stored and replays the worker's event history by date.
 */
export async function pushEvents(events: LedgerEvent[], dbClient?: Awaited<ReturnType<typeof getDb>>): Promise<PushResult> {
  const db = dbClient ?? (await getDb());
  let accepted = 0;
  const acceptedEventIds: string[] = [];
  let duplicates = 0;
  let flaggedAsCorrection = 0;
  let conflicts = 0;
  const workerTargets = new Map<string, WorkerProjectionTarget>();

  for (const ev of events) {
    const exists = await db.query("SELECT event_id FROM events WHERE event_id = $1", [ev.event_id]);
    if ((exists.rows as unknown[]).length > 0) {
      duplicates++;
      collectWorkerProjectionTarget(ev, workerTargets);
      continue;
    }

    const weekStart = getWeekStart(ev.business_date);
    const weekEnd = getWeekEnd(weekStart);
    const lockedCheck = await db.query("SELECT status FROM pay_weeks WHERE farm_id = $1 AND week_start = $2", [
      ev.farm_id,
      weekStart,
    ]);
    const isLocked = (lockedCheck.rows as Array<{ status: string }>)[0]?.status === "locked";
    let correctionFlag = false;
    let conflictFlag = false;

    if (isLocked && !["week.submitted", "correction.requested"].includes(ev.event_type)) {
      correctionFlag = true;
      flaggedAsCorrection++;
    }

    if (ev.event_type === "pluck.logged") {
      const workerId = workerIdFromPayload(ev.payload);
      if (workerId) {
        const dupDay = await db.query(
          "SELECT event_id FROM events WHERE farm_id = $1 AND payload->>'worker_id' = $2 AND business_date = $3 AND event_type = 'pluck.logged' LIMIT 1",
          [ev.farm_id, workerId, ev.business_date],
        );
        if ((dupDay.rows as unknown[]).length > 0) {
          conflictFlag = true;
          conflicts++;
        }
      }
    }

    const inserted = await db.query(
      `INSERT INTO events (event_id, farm_id, device_id, author, event_type, payload, business_date, client_timestamp, server_received_at, correction_flag, conflict_flag)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,NOW(),$9,$10)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        ev.event_id,
        ev.farm_id,
        ev.device_id ?? null,
        ev.author,
        ev.event_type,
        JSON.stringify(ev.payload),
        ev.business_date,
        ev.client_timestamp,
        correctionFlag,
        conflictFlag,
      ],
    );
    // A concurrent device may have inserted the same event after the existence
    // check. It is a duplicate, not a new authorization for side effects.
    if (inserted.rowCount === 0) {
      duplicates++;
      collectWorkerProjectionTarget(ev, workerTargets);
      continue;
    }
    accepted++;
    acceptedEventIds.push(ev.event_id);

    if (WORKER_PROJECTION_EVENTS.has(ev.event_type)) {
      if (collectWorkerProjectionTarget(ev, workerTargets)) {
        // The batch replay below materializes valid events after all dependencies
        // (notably worker.registered) have been persisted.
      } else if (await markEventConflict(ev.event_id, db)) {
        conflicts++;
      }
    }

    if (ev.event_type === "week.submitted") {
      await db.query(
        `INSERT INTO pay_weeks (farm_id, week_start, week_end, status, locked_at)
         VALUES ($1,$2,$3,'locked',NOW())
         ON CONFLICT (farm_id, week_start) DO UPDATE SET status='locked', locked_at=NOW()`,
        [ev.farm_id, weekStart, weekEnd],
      );
    }
  }

  // Replay affected worker event streams only after the full outbox batch has
  // landed. This prevents random UUID outbox-key order from making
  // employment.started arrive before worker.registered.
  for (const target of workerTargets.values()) {
    conflicts += await projectWorkerEvents(target, db);
  }

  return { accepted, acceptedEventIds, duplicates, flaggedAsCorrection, conflicts };
}

export type PullResult = { events: LedgerEvent[]; nextCursor: number | null };

export async function pullEvents(
  sinceCursor: number | null,
  farmId: string,
  limit = 100,
  dbClient?: Awaited<ReturnType<typeof getDb>>,
): Promise<PullResult> {
  const db = dbClient ?? (await getDb());
  const cursor = sinceCursor ?? 0;
  const res = await db.query(
    `SELECT event_id, farm_id, device_id, author, event_type, payload, business_date, client_timestamp, server_received_at, seq
     FROM events WHERE farm_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
    [farmId, cursor, limit],
  );
  const rows = res.rows as Array<{
    event_id: string;
    farm_id: string;
    device_id: string | null;
    author: string;
    event_type: string;
    payload: unknown;
    business_date: string;
    client_timestamp: string;
    server_received_at: string;
    seq: number;
  }>;
  const events: LedgerEvent[] = rows.map((r) => ({
    event_id: r.event_id,
    farm_id: r.farm_id,
    device_id: r.device_id ?? undefined,
    author: r.author,
    event_type: r.event_type,
    payload: r.payload as Record<string, unknown>,
    business_date: typeof r.business_date === "string" ? r.business_date.slice(0, 10) : new Date(r.business_date).toISOString().slice(0, 10),
    client_timestamp: new Date(r.client_timestamp).toISOString(),
    server_received_at: r.server_received_at ? new Date(r.server_received_at).toISOString() : undefined,
    seq: r.seq,
  }));
  const nextCursor = rows.length > 0 ? rows[rows.length - 1].seq : cursor;
  const hasMore = rows.length === limit;
  return { events, nextCursor: hasMore ? nextCursor : null };
}

function collectWorkerProjectionTarget(event: LedgerEvent, targets: Map<string, WorkerProjectionTarget>): boolean {
  const workerId = workerIdFromPayload(event.payload);
  if (!workerId || !isUuid(workerId)) return false;
  const target = { farmId: event.farm_id, workerId };
  targets.set(`${target.farmId}:${target.workerId}`, target);
  return true;
}

async function projectWorkerEvents(target: WorkerProjectionTarget, db: Awaited<ReturnType<typeof getDb>>): Promise<number> {
  const res = await db.query(
    `SELECT event_id, event_type, payload, business_date, seq, conflict_flag
       FROM events
      WHERE farm_id=$1
        AND payload->>'worker_id'=$2
        AND event_type IN ('worker.registered', 'employment.started', 'employment.ended')
      ORDER BY seq ASC`,
    [target.farmId, target.workerId],
  );
  const rows = res.rows as WorkerEventRow[];
  let conflicts = 0;

  // Registration is a prerequisite, regardless of the arrival order of events.
  const registrations = rows.filter((row) => row.event_type === "worker.registered").sort((a, b) => a.seq - b.seq);
  for (const registration of registrations) {
    if (registration.conflict_flag) continue;
    conflicts += await projectWorkerRegistration(target.farmId, target.workerId, registration, db);
  }

  const worker = await db.query("SELECT worker_id FROM workers WHERE worker_id=$1 AND farm_id=$2", [target.workerId, target.farmId]);
  if ((worker.rows as unknown[]).length === 0) {
    // A start/end may arrive in an earlier sync than its registration. Keep the
    // immutable event and defer projection until the registration arrives.
    return conflicts;
  }

  const employmentEvents = rows
    .filter((row) => row.event_type === "employment.started" || row.event_type === "employment.ended")
    .filter((row) => !row.conflict_flag)
    .sort((a, b) => {
      const byDate = effectiveEmploymentDate(a).localeCompare(effectiveEmploymentDate(b));
      if (byDate !== 0) return byDate;
      // Same-day end/start is invalid under inclusive dates; process the end
      // first so any attempted rehire is surfaced as an explicit conflict.
      const priority = (row: WorkerEventRow) => (row.event_type === "employment.ended" ? 0 : 1);
      return priority(a) - priority(b) || a.seq - b.seq;
    });

  for (const event of employmentEvents) {
    if (event.event_type === "employment.started") {
      conflicts += await projectEmploymentStart(target.farmId, target.workerId, event, db);
    } else {
      conflicts += await projectEmploymentEnd(target.farmId, target.workerId, event, db);
    }
  }

  return conflicts;
}

async function projectWorkerRegistration(
  farmId: string,
  workerId: string,
  event: WorkerEventRow,
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<number> {
  const payload = asRecord(event.payload);
  const fullName = typeof payload.full_name === "string" ? payload.full_name.trim() : "";
  const rawPhone = typeof payload.phone_e164 === "string" ? payload.phone_e164 : "";
  const consentAt = typeof payload.consent_at === "string" ? payload.consent_at : "";
  const consentAuthor = typeof payload.consent_author === "string" ? payload.consent_author.trim() : "";
  const normalized = normalizeKePhone(rawPhone);

  if (!fullName || payload.consent !== true || !isTimestamp(consentAt) || !consentAuthor || !normalized.ok) {
    return (await markEventConflict(event.event_id, db)) ? 1 : 0;
  }

  const existingRes = await db.query(
    "SELECT worker_id, farm_id, full_name, phone_e164 FROM workers WHERE worker_id=$1",
    [workerId],
  );
  const existing = (existingRes.rows as WorkerRow[])[0];
  if (existing) {
    const matches =
      existing.farm_id === farmId &&
      existing.full_name === fullName &&
      existing.phone_e164 === normalized.e164;
    return matches ? 0 : (await markEventConflict(event.event_id, db)) ? 1 : 0;
  }

  const activeHolder = await db.query(
    "SELECT worker_id FROM workers WHERE farm_id=$1 AND phone_e164=$2 AND status='active' AND worker_id<>$3 LIMIT 1",
    [farmId, normalized.e164, workerId],
  );
  if ((activeHolder.rows as unknown[]).length > 0) {
    return (await markEventConflict(event.event_id, db)) ? 1 : 0;
  }

  await db.query(
    `INSERT INTO workers (worker_id, farm_id, full_name, phone_e164, status, verified, consent_at, consent_author)
     VALUES ($1,$2,$3,$4,'active',false,$5,$6)`,
    [workerId, farmId, fullName, normalized.e164, consentAt, consentAuthor],
  );
  return 0;
}

async function projectEmploymentStart(
  farmId: string,
  workerId: string,
  event: WorkerEventRow,
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<number> {
  const payload = asRecord(event.payload);
  const startDate = typeof payload.start_date === "string" ? payload.start_date : toDateYmd(event.business_date);
  if (!isDate(startDate)) return (await markEventConflict(event.event_id, db)) ? 1 : 0;

  const sameStart = await db.query(
    "SELECT id FROM employment_periods WHERE worker_id=$1 AND farm_id=$2 AND start_date=$3 LIMIT 1",
    [workerId, farmId, startDate],
  );
  if ((sameStart.rows as unknown[]).length > 0) return 0;

  const active = await db.query(
    "SELECT id FROM employment_periods WHERE worker_id=$1 AND farm_id=$2 AND end_date IS NULL LIMIT 1",
    [workerId, farmId],
  );
  if ((active.rows as unknown[]).length > 0) {
    return (await markEventConflict(event.event_id, db)) ? 1 : 0;
  }

  const lastEnded = await db.query(
    "SELECT end_date FROM employment_periods WHERE worker_id=$1 AND farm_id=$2 AND end_date IS NOT NULL ORDER BY end_date DESC LIMIT 1",
    [workerId, farmId],
  );
  const lastEndDate = (lastEnded.rows as Array<{ end_date: string | Date | null }>)[0]?.end_date;
  if (lastEndDate && startDate <= toDateYmd(lastEndDate)) {
    return (await markEventConflict(event.event_id, db)) ? 1 : 0;
  }

  await db.query(
    "INSERT INTO employment_periods (id, worker_id, farm_id, start_date, end_date) VALUES ($1,$2,$3,$4,null)",
    [randomUUID(), workerId, farmId, startDate],
  );
  await db.query("UPDATE workers SET status='active' WHERE worker_id=$1 AND farm_id=$2", [workerId, farmId]);
  return 0;
}

async function projectEmploymentEnd(
  farmId: string,
  workerId: string,
  event: WorkerEventRow,
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<number> {
  const payload = asRecord(event.payload);
  const endDate = typeof payload.end_date === "string" ? payload.end_date : toDateYmd(event.business_date);
  const reason = typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : null;
  if (!isDate(endDate)) return (await markEventConflict(event.event_id, db)) ? 1 : 0;

  const alreadyClosed = await db.query(
    "SELECT id FROM employment_periods WHERE worker_id=$1 AND farm_id=$2 AND end_date=$3 LIMIT 1",
    [workerId, farmId, endDate],
  );
  if ((alreadyClosed.rows as unknown[]).length > 0) return 0;

  const active = await db.query(
    "SELECT id, start_date FROM employment_periods WHERE worker_id=$1 AND farm_id=$2 AND end_date IS NULL ORDER BY start_date DESC LIMIT 1",
    [workerId, farmId],
  );
  const current = (active.rows as Array<{ id: string; start_date: string | Date }>)[0];
  if (!current || endDate < toDateYmd(current.start_date)) {
    return (await markEventConflict(event.event_id, db)) ? 1 : 0;
  }

  await db.query("UPDATE employment_periods SET end_date=$1, end_reason=$2 WHERE id=$3", [endDate, reason, current.id]);
  await db.query("UPDATE workers SET status='inactive' WHERE worker_id=$1 AND farm_id=$2", [workerId, farmId]);
  return 0;
}

function workerIdFromPayload(payload: unknown): string | null {
  const value = asRecord(payload).worker_id;
  return typeof value === "string" ? value : null;
}

function effectiveEmploymentDate(event: WorkerEventRow): string {
  const payload = asRecord(event.payload);
  const fromPayload = event.event_type === "employment.started" ? payload.start_date : payload.end_date;
  return typeof fromPayload === "string" && isDate(fromPayload) ? fromPayload : toDateYmd(event.business_date);
}

function toDateYmd(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return "";
}

async function markEventConflict(eventId: string, db: Awaited<ReturnType<typeof getDb>>): Promise<boolean> {
  const result = await db.query("UPDATE events SET conflict_flag=true WHERE event_id=$1 AND conflict_flag=false", [eventId]);
  return (result.rowCount ?? 0) > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function isTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00+03:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return toYMD(d);
}

function getWeekEnd(weekStart: string): string {
  const d = new Date(weekStart + "T12:00:00+03:00");
  d.setDate(d.getDate() + 5);
  return toYMD(d);
}

function toYMD(d: Date): string {
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
