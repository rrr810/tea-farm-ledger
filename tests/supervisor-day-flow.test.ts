import { describe, expect, it } from "vitest";
import { activeDateStorageKey, nextCalendarDate, shouldAutoSyncOutbox } from "../apps/supervisor-pwa/src/dayFlow.js";

describe("Supervisor day flow", () => {
  it("uses a per-farm key to persist the active next-day sheet", () => {
    expect(activeDateStorageKey("farm-a")).toBe("active_date:farm-a");
    expect(activeDateStorageKey("farm-a")).not.toBe(activeDateStorageKey("farm-b"));
  });

  it("advances an ISO calendar date without changing the completed day", () => {
    expect(nextCalendarDate("2026-10-24")).toBe("2026-10-25");
    expect(nextCalendarDate("2026-12-31")).toBe("2027-01-01");
  });

  it("auto-syncs worker lifecycle changes while keeping a lone kg event local", () => {
    expect(shouldAutoSyncOutbox([{ type: "worker.registered" }, { type: "employment.started" }])).toBe(true);
    expect(shouldAutoSyncOutbox([{ type: "employment.ended" }])).toBe(true);
    expect(shouldAutoSyncOutbox([{ type: "day.confirmed" }])).toBe(true);
    expect(shouldAutoSyncOutbox([{ type: "day.plucking_set" }])).toBe(true);
    expect(shouldAutoSyncOutbox([{ type: "pluck.logged" }])).toBe(false);
    expect(shouldAutoSyncOutbox([{ type: "unknown" }])).toBe(false);
  });
});
