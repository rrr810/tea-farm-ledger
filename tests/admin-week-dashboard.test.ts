import { describe, expect, it } from "vitest";
import { currentWeekStartEAT, eatIsoDate } from "../apps/admin-web/src/week.js";

describe("owner dashboard current-week helper", () => {
  it("uses the Nairobi calendar rather than the browser's local date", () => {
    // 21:30 UTC Sunday is already Monday 00:30 in Nairobi.
    const instant = new Date("2026-10-25T21:30:00.000Z");
    expect(eatIsoDate(instant)).toBe("2026-10-26");
    expect(currentWeekStartEAT(instant)).toBe("2026-10-26");
  });

  it("returns Monday for a Nairobi Saturday", () => {
    expect(currentWeekStartEAT(new Date("2026-10-24T09:00:00.000Z"))).toBe("2026-10-19");
  });
});
