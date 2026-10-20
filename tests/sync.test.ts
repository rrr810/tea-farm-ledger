import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, runMigrations } from "@tea-ledger/database";
import { pushEvents, pullEvents } from "@tea-ledger/database";
import { generateEventId } from "@tea-ledger/core";
import type { DbClient } from "@tea-ledger/database";
let db: DbClient;
const farmId = "00000000-0000-4000-a000-000000000001";
const deviceId = "00000000-0000-4000-a000-000000000002";
beforeAll(async () => {
  db = await createTestDb();
  await runMigrations(db);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [farmId, "Test Farm"]);
});
afterAll(async () => { if (db?.end) await db.end(); });
describe("sync idempotency and cursor", () => {
  it("push is idempotent by event_id", async () => {
    const eid = generateEventId();
    const ev = { event_id: eid, farm_id: farmId, device_id: deviceId, author: "supervisor-1", event_type: "worker.registered", payload: { worker_id: "w1", full_name: "Jane" }, business_date: "2026-11-23", client_timestamp: new Date().toISOString() };
    const r1 = await pushEvents([ev], db); expect(r1.accepted).toBe(1); expect(r1.duplicates).toBe(0);
    const r2 = await pushEvents([ev], db); expect(r2.accepted).toBe(0); expect(r2.duplicates).toBe(1);
  });
  it("pull by cursor resumes", async () => {
    const eid2 = generateEventId();
    const ev2 = { event_id: eid2, farm_id: farmId, device_id: deviceId, author: "supervisor-1", event_type: "pluck.logged", payload: { worker_id: "w1", kg_units: 100 }, business_date: "2026-11-24", client_timestamp: new Date().toISOString() };
    await pushEvents([ev2], db);
    const p1 = await pullEvents(0, farmId, 10, db);
    expect(p1.events.length).toBeGreaterThanOrEqual(2);
    const next = p1.nextCursor;
    if (next !== null) { const p2 = await pullEvents(next, farmId, 10, db); expect(Array.isArray(p2.events)).toBe(true); } else { const p2 = await pullEvents(p1.events[p1.events.length-1].seq ?? 9999, farmId, 10, db); expect(p2.events.length).toBe(0); }
  });
  it("conflict flagged for same worker same day", async () => {
    const w = "conflict-worker"; const date = "2026-11-25";
    const e1 = { event_id: generateEventId(), farm_id: farmId, device_id: deviceId, author: "supervisor-1", event_type: "pluck.logged", payload: { worker_id: w, kg_units: 100 }, business_date: date, client_timestamp: new Date().toISOString() };
    const e2 = { event_id: generateEventId(), farm_id: farmId, device_id: deviceId, author: "supervisor-2", event_type: "pluck.logged", payload: { worker_id: w, kg_units: 150 }, business_date: date, client_timestamp: new Date().toISOString() };
    await pushEvents([e1], db); const r = await pushEvents([e2], db); expect(r.conflicts).toBe(1);
    const q = await db.query("SELECT conflict_flag FROM events WHERE event_id=$1", [e2.event_id]);
    expect((q.rows as Array<{conflict_flag:boolean}>)[0].conflict_flag).toBe(true);
  });
  it("late events for locked week flagged as correction", async () => {
    const weekStart = "2026-11-23"; const weekEnd = "2026-11-28";
    const lockEv = { event_id: generateEventId(), farm_id: farmId, device_id: deviceId, author: "supervisor-1", event_type: "week.submitted", payload: {}, business_date: weekEnd, client_timestamp: new Date().toISOString() };
    await pushEvents([lockEv], db);
    const check = await db.query("SELECT status FROM pay_weeks WHERE farm_id=$1 AND week_start=$2", [farmId, weekStart]);
    expect((check.rows as Array<{status:string}>)[0].status).toBe("locked");
    const late = { event_id: generateEventId(), farm_id: farmId, device_id: deviceId, author: "supervisor-1", event_type: "pluck.logged", payload: { worker_id: "w2", kg_units: 100 }, business_date: "2026-11-24", client_timestamp: new Date().toISOString() };
    const r = await pushEvents([late], db); expect(r.flaggedAsCorrection).toBe(1);
  });
});
