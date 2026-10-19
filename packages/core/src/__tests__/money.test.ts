import { describe, it, expect } from "vitest";
import { calculateWorkerWeekPayCents, calculateWorkerWeekPayKes, computeWeightedRate, roundCentsToKesHalfUp } from "../money.js";
describe("money - integer arithmetic", () => {
  it("simple 70kg @ 9 KES", () => { const cents = calculateWorkerWeekPayCents([{ kgUnits: 700, rateCentsPerKg: 900 }]); expect(cents).toBe(63000); });
  it("12.5kg @ 9", () => { const cents = calculateWorkerWeekPayCents([{ kgUnits: 125, rateCentsPerKg: 900 }]); expect(cents).toBe(11300); });
  it("rounding half up once per week", () => { const cents = calculateWorkerWeekPayCents([{ kgUnits: 5, rateCentsPerKg: 900 }]); expect(cents).toBe(500); });
  it("mid-week rate change weighted", () => {
    const entries = [{ kgUnits: 100, rateCentsPerKg: 900 }, { kgUnits: 100, rateCentsPerKg: 1000 }];
    const cents = calculateWorkerWeekPayCents(entries); expect(cents).toBe(19000);
    const w = computeWeightedRate(entries); expect(w.totalKgUnits).toBe(200); expect(w.weightedRateCentsPerKg).toBe(950); expect(w.bands.length).toBe(2);
  });
  it("grand total is sum of rounded workers", () => {
    const w1 = calculateWorkerWeekPayCents([{ kgUnits: 125, rateCentsPerKg: 900 }]); const w2 = calculateWorkerWeekPayCents([{ kgUnits: 125, rateCentsPerKg: 900 }]);
    const grand = w1 + w2; expect(grand).toBe(22600);
  });
  it("roundCentsToKesHalfUp", () => { expect(roundCentsToKesHalfUp(11250)).toBe(11300); expect(roundCentsToKesHalfUp(11249)).toBe(11200); expect(roundCentsToKesHalfUp(50)).toBe(100); });
});
