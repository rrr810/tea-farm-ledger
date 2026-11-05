import { describe, expect, it } from "vitest";
import {
  activeDateStorageKey,
  isSaturdayEAT,
  nextCalendarDate,
  nextOperationalDate,
  orderOutboxForSync,
  recoverActiveDate,
  saturdayFinalGate,
  saturdayFinalStorageKey,
  shouldAutoSyncOutbox,
} from "../apps/supervisor-pwa/src/dayFlow.js";

describe("Supervisor day flow", () => {
  it("uses a per-farm key to persist the active next-day sheet", () => {
    expect(activeDateStorageKey("farm-a")).toBe("active_date:farm-a");
    expect(activeDateStorageKey("farm-a")).not.toBe(activeDateStorageKey("farm-b"));
  });

  it("migrates an old completed-today shell onto a blank next-day sheet", () => {
    expect(recoverActiveDate({
      farmId: "farm-a",
      savedActiveDate: null,
      today: "2026-10-24",
      isDateDone: date => date === "2026-10-24",
    })).toBe("2026-10-26");
    expect(recoverActiveDate({
      farmId: "farm-a",
      savedActiveDate: "2026-10-25",
      today: "2026-10-24",
      isDateDone: date => date === "2026-10-24",
    })).toBe("2026-10-25");
    expect(recoverActiveDate({
      farmId: "farm-a",
      savedActiveDate: null,
      today: "2026-10-24",
      isDateDone: () => false,
    })).toBe("2026-10-24");
  });

  it("repairs a saved active pointer that still names a completed sheet", () => {
    expect(recoverActiveDate({
      farmId: "farm-a",
      savedActiveDate: "2026-10-24",
      today: "2026-10-24",
      isDateDone: date => date === "2026-10-24",
    })).toBe("2026-10-26");
    expect(recoverActiveDate({
      farmId: "farm-a",
      savedActiveDate: "2026-10-24",
      today: "2026-10-24",
      isDateDone: date => date === "2026-10-24" || date === "2026-10-25",
    })).toBe("2026-10-26");
  });

  it("advances an ISO calendar date without changing the completed day", () => {
    expect(nextCalendarDate("2026-10-24")).toBe("2026-10-25");
    expect(nextCalendarDate("2026-12-31")).toBe("2027-01-01");
  });

  it("holds a completed Saturday until FINAL and opens Monday after confirmation", () => {
    expect(isSaturdayEAT("2026-11-28")).toBe(true);
    expect(nextOperationalDate("2026-11-28")).toBe("2026-11-30");
    expect(saturdayFinalStorageKey("farm-a", "2026-11-28")).toBe(
      "saturday_final:farm-a:2026-11-28",
    );
    expect(recoverActiveDate({
      farmId: "farm-a",
      savedActiveDate: "2026-11-28",
      today: "2026-11-28",
      isDateDone: date => date === "2026-11-28",
      canAdvancePastDate: () => false,
    })).toBe("2026-11-28");
    expect(recoverActiveDate({
      farmId: "farm-a",
      savedActiveDate: "2026-11-28",
      today: "2026-11-28",
      isDateDone: date => date === "2026-11-28",
      canAdvancePastDate: () => true,
    })).toBe("2026-11-30");
  });

  it("enables FINAL only for a completed, unqueued Saturday", () => {
    expect(saturdayFinalGate({ date: "2026-11-27", dayDone: true, submissionState: "idle" })).toBe("not-saturday");
    expect(saturdayFinalGate({ date: "2026-11-28", dayDone: false, submissionState: "idle" })).toBe("saturday-not-done");
    expect(saturdayFinalGate({ date: "2026-11-28", dayDone: true, submissionState: "queued" })).toBe("queued");
    expect(saturdayFinalGate({ date: "2026-11-28", dayDone: true, submissionState: "confirmed" })).toBe("confirmed");
    expect(saturdayFinalGate({ date: "2026-11-28", dayDone: true, submissionState: "idle" })).toBe("ready");
  });

  it("puts FINAL after the Saturday completion batch regardless of random IDs", () => {
    const ordered = orderOutboxForSync([
      { type: "week.submitted", createdAt: "2026-11-28T08:00:02Z", event_id: "000-final" },
      { type: "day.confirmed", createdAt: "2026-11-28T08:00:01Z", event_id: "zzz-done" },
      { type: "pluck.logged", createdAt: "2026-11-28T08:00:00Z", event_id: "aaa-pluck" },
    ]);
    expect(ordered.map(item => item.type)).toEqual([
      "pluck.logged",
      "day.confirmed",
      "week.submitted",
    ]);
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
