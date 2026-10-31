import { describe, expect, it } from "vitest";
import {
  computeWeeklyKgRegister,
  formatKgUnits,
  weeklyKgRegisterToCsv,
  weeklyKgRegisterToPrintableHtml,
  type PluckEntry,
  type WorkerInfo,
} from "@tea-ledger/core";

const days = [
  { date: "2026-10-26", isPluckingDay: true },
  { date: "2026-10-27", isPluckingDay: false },
  { date: "2026-10-28", isPluckingDay: true },
  { date: "2026-10-29", isPluckingDay: true },
  { date: "2026-10-30", isPluckingDay: true },
  { date: "2026-10-31", isPluckingDay: true },
];

const workers: WorkerInfo[] = [
  {
    workerId: "worker-a",
    fullName: "Amina <Estate>",
    phoneE164: null,
    verified: true,
    employmentPeriods: [{ startDate: "2026-10-01", endDate: null }],
  },
  {
    workerId: "worker-b",
    fullName: "Benson Kiptoo",
    phoneE164: null,
    verified: true,
    employmentPeriods: [{ startDate: "2026-10-28", endDate: null }],
  },
];

function registerFor(entries: Map<string, PluckEntry[]>) {
  return computeWeeklyKgRegister({
    farmId: "farm-12345678",
    weekStart: "2026-10-26",
    weekEnd: "2026-10-31",
    status: "open",
    lockedAt: null,
    workers,
    plucksByWorker: entries,
    pluckingDays: days,
  });
}

describe("weekly kg register", () => {
  it("keeps daily kg as integer tenths and distinguishes A, NP and blank cells", () => {
    const register = registerFor(
      new Map([
        [
          "worker-a",
          [
            { workerId: "worker-a", businessDate: "2026-10-26", kgUnits: 343, present: true },
            { workerId: "worker-a", businessDate: "2026-10-28", kgUnits: null, present: false },
            { workerId: "worker-a", businessDate: "2026-10-30", kgUnits: 0, present: true },
          ],
        ],
        [
          "worker-b",
          [{ workerId: "worker-b", businessDate: "2026-10-30", kgUnits: 207, present: true }],
        ],
      ]),
    );

    expect(register.rows.map((row) => row.name)).toEqual(["Amina <Estate>", "Benson Kiptoo"]);
    const amina = register.rows[0]!;
    const benson = register.rows[1]!;
    expect(amina.cells.map((cell) => cell.label)).toEqual(["34.3", "NP", "A", "—", "0.0", "—"]);
    expect(benson.cells.map((cell) => cell.label)).toEqual(["—", "—", "—", "—", "20.7", "—"]);
    expect(amina.totalKgUnits).toBe(343);
    expect(benson.totalKgUnits).toBe(207);
    expect(register.days.map((day) => day.totalLabel)).toEqual(["34.3", "0.0", "0.0", "0.0", "20.7", "0.0"]);
    expect(register.totals).toMatchObject({ totalKgUnits: 550, totalLabel: "55.0", workerCount: 2 });
    expect(formatKgUnits(343)).toBe("34.3");
  });

  it("surfaces duplicate or flagged entries instead of silently choosing one", () => {
    const register = registerFor(
      new Map([
        [
          "worker-a",
          [
            { workerId: "worker-a", businessDate: "2026-10-26", kgUnits: 100, present: true },
            { workerId: "worker-a", businessDate: "2026-10-26", kgUnits: 45, present: true, conflictFlag: true },
          ],
        ],
      ]),
    );

    const amina = register.rows.find((row) => row.workerId === "worker-a")!;
    expect(amina.cells[0]).toMatchObject({ state: "conflict", kgUnits: 145, label: "14.5*" });
    expect(register.hasConflicts).toBe(true);
    const csv = weeklyKgRegisterToCsv(register);
    expect(csv).toContain("14.5*");
    expect(csv).toContain("DAILY TOTALS");
    const html = weeklyKgRegisterToPrintableHtml(register, "Amina <Estate> Farm", "29/10/2026, 10:15:00");
    expect(html).toContain("Weekly Leaf Register");
    expect(html).toContain("Print / Save as PDF");
    expect(html).toContain("Review required.");
    expect(html).not.toContain("Amina <Estate> Farm");
    expect(html).toContain("Amina &lt;Estate&gt; Farm");
  });
});
