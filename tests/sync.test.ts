import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, runMigrations } from "@tea-ledger/database";
import { pushEvents, pullEvents } from "@tea-ledger/database";
import { generateEventId } from "@tea-ledger/core";
import type { DbClient } from "@tea-ledger/database";

let db: DbClient;
const farmId = "00000000-0000-4000-a000-000000000001";
const deviceId = "00000000-0000-4000-a000-000000000002";
const workerId = "00000000-0000-4000-a000-000000000003";

function registeredEvent(id = generateEventId()) {
  return {
    event_id: id,
    farm_id: farmId,
    device_id: deviceId,
    author: "supervisor-1",
    event_type: "worker.registered",
    payload: {
      worker_id: workerId,
      full_name: "Jane Test",
      phone_e164: "+254700000001",
      consent: true,
      consent_at: "2026-11-23T06:00:00.000Z",
      consent_author: "supervisor-1",
    },
    business_date: "2026-11-23",
    client_timestamp: new Date().toISOString(),
  };
}

function ymd(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function employmentStartedEvent(id = generateEventId(), startDate = "2026-11-23") {
  return {
    event_id: id,
    farm_id: farmId,
    device_id: deviceId,
    author: "supervisor-1",
    event_type: "employment.started",
    payload: { worker_id: workerId, start_date: startDate },
    business_date: startDate,
    client_timestamp: new Date().toISOString(),
  };
}

beforeAll(async () => {
  db = await createTestDb();
  await runMigrations(db);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [farmId, "Test Farm"]);
});

afterAll(async () => {
  if (db?.end) await db.end();
});

describe("sync idempotency and cursor", () => {
  it("projects PWA worker registration and employment even when events arrive out of order", async () => {
    const registration = registeredEvent();
    const employment = employmentStartedEvent();

    // The PWA outbox primary key is a UUID, so it must not rely on local insertion
    // order. The server materializes the profile only after both events land.
    const r1 = await pushEvents([employment, registration], db);
    expect(r1.accepted).toBe(2);
    expect(r1.acceptedEventIds).toEqual(expect.arrayContaining([employment.event_id, registration.event_id]));
    expect(r1.duplicates).toBe(0);
    expect(r1.conflicts).toBe(0);

    const workers = await db.query(
      "SELECT worker_id, farm_id, full_name, phone_e164, status, verified, consent_author FROM workers WHERE worker_id=$1",
      [workerId],
    );
    expect(workers.rows).toEqual([
      expect.objectContaining({
        worker_id: workerId,
        farm_id: farmId,
        full_name: "Jane Test",
        phone_e164: "+254700000001",
        status: "active",
        verified: false,
        consent_author: "supervisor-1",
      }),
    ]);

    const periods = await db.query(
      "SELECT worker_id, farm_id, start_date, end_date FROM employment_periods WHERE worker_id=$1",
      [workerId],
    );
    const firstPeriod = (periods.rows as Array<{ worker_id: string; farm_id: string; start_date: unknown; end_date: unknown }>)[0];
    expect(firstPeriod).toEqual(expect.objectContaining({ worker_id: workerId, farm_id: farmId, end_date: null }));
    expect(ymd(firstPeriod.start_date)).toBe("2026-11-23");

    const r2 = await pushEvents([employment, registration], db);
    expect(r2.accepted).toBe(0);
    expect(r2.acceptedEventIds).toEqual([]);
    expect(r2.duplicates).toBe(2);
    const workerCount = await db.query("SELECT COUNT(*)::int AS count FROM workers WHERE worker_id=$1", [workerId]);
    const periodCount = await db.query("SELECT COUNT(*)::int AS count FROM employment_periods WHERE worker_id=$1", [workerId]);
    expect(Number((workerCount.rows as Array<{ count: number }>)[0].count)).toBe(1);
    expect(Number((periodCount.rows as Array<{ count: number }>)[0].count)).toBe(1);
  });

  it("replays a deferred employment event when registration reaches a later sync", async () => {
    const deferredWorkerId = "00000000-0000-4000-a000-000000000006";
    const startFirst = {
      ...employmentStartedEvent(),
      payload: { worker_id: deferredWorkerId, start_date: "2026-11-26" },
      business_date: "2026-11-26",
    };
    const firstResult = await pushEvents([startFirst], db);
    expect(firstResult.accepted).toBe(1);
    expect(firstResult.conflicts).toBe(0);

    const registrationLater = {
      ...registeredEvent(),
      payload: {
        worker_id: deferredWorkerId,
        full_name: "Deferred Test",
        phone_e164: "+254700000004",
        consent: true,
        consent_at: "2026-11-26T06:00:00.000Z",
        consent_author: "supervisor-1",
      },
      business_date: "2026-11-26",
    };
    const secondResult = await pushEvents([registrationLater], db);
    expect(secondResult.accepted).toBe(1);
    expect(secondResult.conflicts).toBe(0);

    const period = (await db.query(
      "SELECT start_date, end_date FROM employment_periods WHERE worker_id=$1",
      [deferredWorkerId],
    )).rows as Array<{ start_date: unknown; end_date: unknown }>;
    expect(period).toHaveLength(1);
    expect(ymd(period[0].start_date)).toBe("2026-11-26");
    expect(period[0].end_date).toBeNull();
  });

  it("projects an end and rehire as separate inclusive employment periods", async () => {
    const rehireId = "00000000-0000-4000-a000-000000000004";
    const registered = {
      ...registeredEvent(),
      payload: {
        worker_id: rehireId,
        full_name: "Rehire Test",
        phone_e164: "+254700000002",
        consent: true,
        consent_at: "2026-11-23T06:00:00.000Z",
        consent_author: "supervisor-1",
      },
    };
    const start = {
      ...employmentStartedEvent(),
      payload: { worker_id: rehireId, start_date: "2026-11-23" },
      business_date: "2026-11-23",
    };
    const ended = {
      event_id: generateEventId(),
      farm_id: farmId,
      device_id: deviceId,
      author: "supervisor-1",
      event_type: "employment.ended",
      payload: { worker_id: rehireId, end_date: "2026-11-24", reason: "test leave" },
      business_date: "2026-11-24",
      client_timestamp: new Date().toISOString(),
    };
    const rehire = {
      ...employmentStartedEvent(),
      payload: { worker_id: rehireId, start_date: "2026-11-25" },
      business_date: "2026-11-25",
    };

    const result = await pushEvents([rehire, ended, start, registered], db);
    expect(result.accepted).toBe(4);
    expect(result.conflicts).toBe(0);

    const worker = await db.query("SELECT status FROM workers WHERE worker_id=$1", [rehireId]);
    expect((worker.rows as Array<{ status: string }>)[0].status).toBe("active");
    const periods = (await db.query(
      "SELECT start_date, end_date, end_reason FROM employment_periods WHERE worker_id=$1 ORDER BY start_date",
      [rehireId],
    )).rows as Array<{ start_date: unknown; end_date: unknown; end_reason: string | null }>;
    expect(periods).toHaveLength(2);
    expect({ start_date: ymd(periods[0].start_date), end_date: ymd(periods[0].end_date), end_reason: periods[0].end_reason }).toEqual({
      start_date: "2026-11-23",
      end_date: "2026-11-24",
      end_reason: "test leave",
    });
    expect({ start_date: ymd(periods[1].start_date), end_date: periods[1].end_date, end_reason: periods[1].end_reason }).toEqual({
      start_date: "2026-11-25",
      end_date: null,
      end_reason: null,
    });
  });

  it("flags active-phone reuse instead of silently creating a second worker", async () => {
    const conflictingWorkerId = "00000000-0000-4000-a000-000000000005";
    const duplicatePhone = {
      ...registeredEvent(),
      payload: {
        worker_id: conflictingWorkerId,
        full_name: "Duplicate Phone Test",
        phone_e164: "+254700000001",
        consent: true,
        consent_at: "2026-11-23T06:00:00.000Z",
        consent_author: "supervisor-1",
      },
    };
    const result = await pushEvents([duplicatePhone], db);
    expect(result.accepted).toBe(1);
    expect(result.conflicts).toBe(1);
    const worker = await db.query("SELECT worker_id FROM workers WHERE worker_id=$1", [conflictingWorkerId]);
    expect(worker.rows).toEqual([]);
    const saved = await db.query("SELECT conflict_flag FROM events WHERE event_id=$1", [duplicatePhone.event_id]);
    expect((saved.rows as Array<{ conflict_flag: boolean }>)[0].conflict_flag).toBe(true);
  });

  it("flags an invalid registration explicitly instead of silently creating a worker", async () => {
    const invalid = {
      ...registeredEvent(),
      payload: {
        worker_id: "not-a-uuid",
        full_name: "Bad Event",
        phone_e164: "+254700000003",
        consent: false,
      },
    };
    const result = await pushEvents([invalid], db);
    expect(result.accepted).toBe(1);
    expect(result.conflicts).toBe(1);
    const saved = await db.query("SELECT conflict_flag FROM events WHERE event_id=$1", [invalid.event_id]);
    expect((saved.rows as Array<{ conflict_flag: boolean }>)[0].conflict_flag).toBe(true);
  });

  it("pull by cursor resumes", async () => {
    const eid2 = generateEventId();
    const ev2 = {
      event_id: eid2,
      farm_id: farmId,
      device_id: deviceId,
      author: "supervisor-1",
      event_type: "pluck.logged",
      payload: { worker_id: workerId, kg_units: 100 },
      business_date: "2026-11-24",
      client_timestamp: new Date().toISOString(),
    };
    await pushEvents([ev2], db);
    const p1 = await pullEvents(0, farmId, 20, db);
    expect(p1.events.length).toBeGreaterThanOrEqual(7);
    const next = p1.nextCursor;
    if (next !== null) {
      const p2 = await pullEvents(next, farmId, 20, db);
      expect(Array.isArray(p2.events)).toBe(true);
    } else {
      const p2 = await pullEvents(p1.events[p1.events.length - 1].seq ?? 9999, farmId, 20, db);
      expect(p2.events.length).toBe(0);
    }
  });

  it("conflict flagged for same worker same day", async () => {
    const w = "conflict-worker";
    const date = "2026-11-25";
    const e1 = {
      event_id: generateEventId(),
      farm_id: farmId,
      device_id: deviceId,
      author: "supervisor-1",
      event_type: "pluck.logged",
      payload: { worker_id: w, kg_units: 100 },
      business_date: date,
      client_timestamp: new Date().toISOString(),
    };
    const e2 = {
      event_id: generateEventId(),
      farm_id: farmId,
      device_id: deviceId,
      author: "supervisor-2",
      event_type: "pluck.logged",
      payload: { worker_id: w, kg_units: 150 },
      business_date: date,
      client_timestamp: new Date().toISOString(),
    };
    await pushEvents([e1], db);
    const r = await pushEvents([e2], db);
    expect(r.conflicts).toBe(1);
    const q = await db.query("SELECT conflict_flag FROM events WHERE event_id=$1", [e2.event_id]);
    expect((q.rows as Array<{ conflict_flag: boolean }>)[0].conflict_flag).toBe(true);
  });

  it("late events for locked week flagged as correction", async () => {
    const weekStart = "2026-11-23";
    const weekEnd = "2026-11-28";
    const lockEv = {
      event_id: generateEventId(),
      farm_id: farmId,
      device_id: deviceId,
      author: "supervisor-1",
      event_type: "week.submitted",
      payload: {},
      business_date: weekEnd,
      client_timestamp: new Date().toISOString(),
    };
    await pushEvents([lockEv], db);
    const check = await db.query("SELECT status FROM pay_weeks WHERE farm_id=$1 AND week_start=$2", [farmId, weekStart]);
    expect((check.rows as Array<{ status: string }>)[0].status).toBe("locked");
    const late = {
      event_id: generateEventId(),
      farm_id: farmId,
      device_id: deviceId,
      author: "supervisor-1",
      event_type: "pluck.logged",
      payload: { worker_id: "w2", kg_units: 100 },
      business_date: "2026-11-24",
      client_timestamp: new Date().toISOString(),
    };
    const r = await pushEvents([late], db);
    expect(r.flaggedAsCorrection).toBe(1);
  });
});
