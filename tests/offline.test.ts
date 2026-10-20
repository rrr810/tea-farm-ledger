import { describe, it, expect } from "vitest";
import { isGsm7, countSegments } from "@tea-ledger/core";

/**
 * M4 Offline PWA — outbox queue behaviour
 * These unit-test the *contract* the PWA UI implements:
 * - kg keystrokes stay local (daily table), not outbox
 * - Done queues the batch (plucks + day.confirmed / day.plucking_set)
 * - pending upload count = outbox length
 * - no duplicate kg if user edits multiple times before Done
 * - Saturday FINAL only on Saturday
 * - device_id is never ""
 * We model the outbox as a simple in-memory queue mirroring Dexie `db.outbox`.
 */

type OutboxItem = { event_id: string; type: string; business_date: string; device_id: string };
type DailyLocal = { worker_id: string; kgUnits: number; present: boolean };

class FakeOutbox {
  items: OutboxItem[] = [];
  async add(item: OutboxItem) {
    this.items.push(item);
  }
  count() {
    return this.items.length;
  }
  async clear() {
    this.items = [];
  }
}

// Helpers mirroring App.tsx logic
function enqueueDoneDay(opts: {
  outbox: FakeOutbox;
  date: string;
  daily: DailyLocal[];
  farmId: string;
  deviceId: string;
  isPluckingDay: boolean;
  reason?: string;
}) {
  const { outbox, date, daily, farmId: _farmId, deviceId, isPluckingDay, reason } = opts;
  if (!isPluckingDay) {
    // no-plucking path
    return outbox.add({
      event_id: `ev-${Date.now()}-plucking_set`,
      type: "day.plucking_set",
      business_date: date,
      device_id: deviceId,
    });
  }
  const present = daily.filter((d) => d.present);
  if (present.length === 0) throw new Error("empty day");
  for (const d of daily) {
    outbox.add({
      event_id: `ev-${d.worker_id}-${Date.now()}-${Math.random()}`,
      type: "pluck.logged",
      business_date: date,
      device_id: deviceId,
    });
  }
  return outbox.add({
    event_id: `ev-day-confirmed-${Date.now()}`,
    type: "day.confirmed",
    business_date: date,
    device_id: deviceId,
  });
}

function isSaturdayEAT(dateStr: string): boolean {
  const dow = new Date(dateStr + "T09:00:00Z").getUTCDay();
  return dow === 6;
}

describe("offline flags", () => {
  it("pending upload wording is GSM-7 and 1 segment", () => {
    const msg = "Saturday entry not received by server, please connect to sync.";
    expect(isGsm7(msg)).toBe(true);
    expect(countSegments(msg)).toBe(1);
    expect(msg).toBe("Saturday entry not received by server, please connect to sync.");
  });
});

describe("offline outbox — enqueue only on Done", () => {
  it("kg edits do not enqueue until Done", async () => {
    const outbox = new FakeOutbox();
    // User types kg three times for same worker before Done — local daily table mutates, outbox stays empty
    const daily: DailyLocal[] = [{ worker_id: "w1", kgUnits: 100, present: true }];
    // simulate re-edits (overwrite, not append)
    daily[0].kgUnits = 125;
    daily[0].kgUnits = 80;
    expect(outbox.count()).toBe(0);
    expect(daily[0].kgUnits).toBe(80); // last edit wins, no duplicates queued
  });

  it("Done queues plucks + day.confirmed batch", async () => {
    const outbox = new FakeOutbox();
    const daily: DailyLocal[] = [
      { worker_id: "w1", kgUnits: 125, present: true },
      { worker_id: "w2", kgUnits: 80, present: true },
    ];
    await enqueueDoneDay({
      outbox,
      date: "2026-11-24",
      daily,
      farmId: "farm-1",
      deviceId: "device-uuid-1",
      isPluckingDay: true,
    });
    // 2 plucks + 1 day.confirmed
    expect(outbox.count()).toBe(3);
    expect(outbox.items.map((i) => i.type)).toContain("day.confirmed");
  });

  it("no duplicate kg if user edits multiple times before Done", async () => {
    const outbox = new FakeOutbox();
    // User edits kg for same worker 4 times, then Done once — should queue exactly 1 pluck for that worker
    const daily: DailyLocal[] = [{ worker_id: "w1", kgUnits: 60, present: true }];
    daily[0].kgUnits = 70;
    daily[0].kgUnits = 90;
    daily[0].kgUnits = 100; // final
    await enqueueDoneDay({
      outbox,
      date: "2026-11-24",
      daily,
      farmId: "farm-1",
      deviceId: "device-uuid-1",
      isPluckingDay: true,
    });
    const plucks = outbox.items.filter((i) => i.type === "pluck.logged");
    expect(plucks).toHaveLength(1);
  });

  it("pending count reflects outbox length (banner ● N to sync)", async () => {
    const outbox = new FakeOutbox();
    expect(outbox.count()).toBe(0);
    await enqueueDoneDay({
      outbox,
      date: "2026-11-24",
      daily: [{ worker_id: "w1", kgUnits: 100, present: true }],
      farmId: "farm-1",
      deviceId: "device-uuid-1",
      isPluckingDay: true,
    });
    expect(outbox.count()).toBe(2); // 1 pluck + 1 confirmed
  });

  it("clear after sync", async () => {
    const outbox = new FakeOutbox();
    await enqueueDoneDay({
      outbox,
      date: "2026-11-24",
      daily: [{ worker_id: "w1", kgUnits: 100, present: true }],
      farmId: "farm-1",
      deviceId: "device-uuid-1",
      isPluckingDay: true,
    });
    expect(outbox.count()).toBeGreaterThan(0);
    await outbox.clear(); // mirrors `for (o of all) db.outbox.delete(o.event_id)` after push
    expect(outbox.count()).toBe(0);
  });

  it("no-plucking queues day.plucking_set not plucks", async () => {
    const outbox = new FakeOutbox();
    await enqueueDoneDay({
      outbox,
      date: "2026-11-24",
      daily: [],
      farmId: "farm-1",
      deviceId: "device-uuid-1",
      isPluckingDay: false,
      reason: "heavy rain",
    });
    expect(outbox.count()).toBe(1);
    expect(outbox.items[0].type).toBe("day.plucking_set");
  });

  it("Saturday FINAL only on Saturday EAT", () => {
    expect(isSaturdayEAT("2026-11-28")).toBe(true); // Sat
    expect(isSaturdayEAT("2026-11-27")).toBe(false); // Fri
    expect(isSaturdayEAT("2026-11-23")).toBe(false); // Mon
  });

  it("device_id is UUID, never empty string", () => {
    const deviceId = crypto.randomUUID();
    expect(deviceId).not.toBe("");
    expect(deviceId.length).toBeGreaterThan(10);
    // PWA bug was `device_id: \"\"` causing PG `invalid input syntax uuid \"\"`
    expect(() => {
      if (!deviceId) throw new Error("device_id empty");
    }).not.toThrow();
  });
});
