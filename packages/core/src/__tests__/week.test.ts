import { describe, it, expect } from "vitest";
import { getWeekStartMonday, getWeekEndSaturday, weekRangeFromDate } from "../week.js";
describe("week", () => {
  it("Monday to Saturday", () => { expect(getWeekStartMonday("2026-11-23")).toBe("2026-11-23"); expect(getWeekEndSaturday("2026-11-23")).toBe("2026-11-28"); expect(weekRangeFromDate("2026-11-25")).toEqual({ start: "2026-11-23", end: "2026-11-28" }); });
  it("Sunday belongs to previous Mon", () => { expect(getWeekStartMonday("2026-11-29")).toBe("2026-11-23"); });
});
