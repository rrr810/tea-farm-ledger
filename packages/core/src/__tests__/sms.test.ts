import { describe, it, expect } from "vitest";
import { countSegments, isGsm7, buildWeeklyReceiptSms, buildDailySms } from "../sms-helpers.js";
describe("sms", () => {
  it("counts segments", () => { expect(countSegments("a".repeat(160))).toBe(1); expect(countSegments("a".repeat(161))).toBe(2); expect(countSegments("a".repeat(306))).toBe(2); expect(countSegments("a".repeat(307))).toBe(3); });
  it("GSM7 only", () => { expect(isGsm7("Hello 123")).toBe(true); expect(isGsm7("Hello—")).toBe(false); expect(isGsm7("😀")).toBe(false); });
  it("weekly receipt fits 2 segments", () => {
    const { body, segments } = buildWeeklyReceiptSms({ workerName: "Jane", tokens: { Mon: "12", Tue: "14", Wed: "0", Thu: "A", Fri: "14", Sat: "NP" }, totalKgUnits: 400, rateCentsPerKg: 900, amountKes: 360, weekLabel: "Wk43" });
    expect(segments).toBeLessThanOrEqual(2); expect(body).toContain("Wk43 Jane:");
  });
  it("daily SMS order highest first", () => {
    const { body } = buildDailySms({ dateLabel: "Mon 19Oct", totalKgUnits: 1000, pickerCount: 3, lines: [{ name: "Peter", kgUnits: 520 }, { name: "Jane", kgUnits: 450 }, { name: "Mary", kgUnits: 300 }], rateCentsPerKg: 900 });
    const lines = body.split("\n"); expect(lines[2]).toContain("Peter");
  });
});
