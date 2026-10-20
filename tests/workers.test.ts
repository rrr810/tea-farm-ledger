import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, runMigrations } from "@tea-ledger/database";
import { createWorker, startEmployment, endEmployment, listEmployment } from "@tea-ledger/database";
import type { DbClient } from "@tea-ledger/database";
let db: DbClient;
const farmId = "00000000-0000-4000-a000-000000000010";
beforeAll(async () => {
  db = await createTestDb();
  await runMigrations(db);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [farmId, "Farm2"]);
});
afterAll(async () => { if (db?.end) await db.end(); });
describe("workers lifecycle", () => {
  it("create worker + inclusive employment", async () => {
    const w = await createWorker({ farmId, fullName: "Kiptoo", phone: "0712345678", consentAuthor: "sup", dbClient: db });
    expect(w.phone_e164).toBe("+254712345678");
    await startEmployment({ workerId: w.worker_id, farmId, startDate: "2026-11-01", dbClient: db });
    const periods = await listEmployment(w.worker_id, db);
    expect(periods.length).toBe(1);
    await endEmployment({ workerId: w.worker_id, endDate: "2026-11-15", reason: "quit", dbClient: db });
    const p2 = await listEmployment(w.worker_id, db) as Array<any>;
    const endDateStr = p2[0].end_date instanceof Date ? (p2[0].end_date as Date).toISOString().slice(0,10) : String(p2[0].end_date);
    expect(endDateStr).toBe("2026-11-15");
    await startEmployment({ workerId: w.worker_id, farmId, startDate: "2026-11-16", dbClient: db });
    expect((await listEmployment(w.worker_id, db)).length).toBe(2);
    await expect(startEmployment({ workerId: w.worker_id, farmId, startDate: "2026-11-16", dbClient: db })).rejects.toThrow();
  });
  it("phone reuse blocked while active", async () => {
    const w1 = await createWorker({ farmId, fullName: "A", phone: "0711111111", consentAuthor: "sup", dbClient: db });
    await expect(createWorker({ farmId, fullName: "B", phone: "0711111111", consentAuthor: "sup", dbClient: db })).rejects.toThrow();
    await startEmployment({ workerId: w1.worker_id, farmId, startDate: "2026-11-01", dbClient: db });
    await endEmployment({ workerId: w1.worker_id, endDate: "2026-11-05", dbClient: db });
    await db.query("UPDATE workers SET status='inactive' WHERE worker_id=$1", [w1.worker_id]);
    const w2 = await createWorker({ farmId, fullName: "B", phone: "0711111111", consentAuthor: "sup", dbClient: db });
    expect(w2.phone_e164).toBe("+254711111111");
  });
});
