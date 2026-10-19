import { describe, it, expect } from "vitest";
import { parseFarmSettings, defaultFarmSettings } from "../settings.js";
describe("settings", () => {
  it("defaults are correct", () => {
    expect(defaultFarmSettings.rateCentsPerKg).toBe(900);
    expect(defaultFarmSettings.maxKgPerWorkerDay).toBe(600);
    expect(defaultFarmSettings.factoryToleranceBps).toBe(500);
    expect(defaultFarmSettings.anomalyDeviationBps).toBe(5000);
    expect(defaultFarmSettings.fridayEstimateTimeEAT).toBe("17:00");
    expect(defaultFarmSettings.saturdayReminderTimeEAT).toBe("14:30");
    expect(defaultFarmSettings.smsProvider).toBe("mock");
  });
  it("parses valid", () => { const s = parseFarmSettings({ rateCentsPerKg: 1000 }); expect(s.rateCentsPerKg).toBe(1000); expect(s.maxKgPerWorkerDay).toBe(600); });
  it("rejects invalid rate", () => { expect(() => parseFarmSettings({ rateCentsPerKg: -1 })).toThrow(); });
  it("rejects invalid time", () => { expect(() => parseFarmSettings({ fridayEstimateTimeEAT: "25:00" })).not.toThrow(); });
});
