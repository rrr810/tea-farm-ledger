import { describe, it, expect } from "vitest";
import { countSegments, isGsm7, buildWeeklyReceiptSms, buildDailySms } from "../sms-helpers.js";
describe("sms", () => {
  it("counts segments", () => { expect(countSegments("a".repeat(160))).toBe(1); expect(countSegments("a".repeat(161))).toBe(2); expect(countSegments("a".repeat(306))).toBe(2); expect(countSegments("a".repeat(307))).toBe(3); });
  it("GSM7 only", () => { expect(isGsm7("Hello 123")).toBe(true); expect(isGsm7("Hello—")).toBe(false); expect(isGsm7("😀")).toBe(false); });
  it("weekly receipt fits 2 segments", () => {
    const { body, segments } = buildWeeklyReceiptSms({ workerName: "Jane", tokens: { Mon: "12", Tue: "14", Wed: "0", Thu: "A", Fri: "14", Sat: "NP" }, totalKgUnits: 400, rateCentsPerKg: 900, amountKes: 360, weekLabel: "Wk43" });
    expect(segments).toBeLessThanOrEqual(2); expect(body).toContain("Wk43 Jane:");
  });
  it("builds Peter's readable daily table with every picker", () => {
    const workers = [
      { name: "Kiptoo", kgUnits: 455 },
      { name: "Amina", kgUnits: 486 },
      { name: "Beatrice", kgUnits: 422 },
      { name: "Cheruiyot", kgUnits: 510 },
      { name: "David", kgUnits: 394 },
      { name: "Evans", kgUnits: 468 },
      { name: "Faith", kgUnits: 441 },
      { name: "Grace", kgUnits: 526 },
      { name: "Hannah", kgUnits: 379 },
      { name: "Isaac", kgUnits: 493 },
      { name: "Janet", kgUnits: 417 },
      { name: "Kevin", kgUnits: 502 },
    ];
    const { body, segments, gsm7 } = buildDailySms({
      ownerName: "Peter Rugut",
      dateLabel: "23 Oct",
      totalKgUnits: 5493,
      pickerCount: workers.length,
      lines: workers,
      rateCentsPerKg: 3000,
      totalPayEstimateKes: 16479,
    });

    expect(body).toContain("Dear Peter Rugut,");
    expect(body).toContain("NAME | KG | EST KES");
    expect(body).toContain("Kiptoo | 45.5 | 1,365");
    expect(body).toContain("TOTAL | 549.3 | 16,479");
    for (const worker of workers) expect(body).toContain(worker.name);
    expect(body.indexOf("Amina | 48.6 | 1,458")).toBeLessThan(body.indexOf("Kiptoo | 45.5 | 1,365"));
    expect(gsm7).toBe(true);
    expect(segments).toBe(3);
  });
});
