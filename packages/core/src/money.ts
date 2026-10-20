export function calculateWorkerWeekPayCents(
  entries: Array<{ kgUnits: number; rateCentsPerKg: number }>,
): number {
  let numerator = 0;
  for (const e of entries) {
    if (e.kgUnits < 0) throw new Error("negative kg");
    if (e.rateCentsPerKg < 0) throw new Error("negative rate");
    numerator += e.kgUnits * e.rateCentsPerKg;
  }
  const wholeKes = Math.floor((numerator + 500) / 1000);
  return wholeKes * 100;
}
export function calculateWorkerWeekPayKes(
  entries: Array<{ kgUnits: number; rateCentsPerKg: number }>,
): number {
  const cents = calculateWorkerWeekPayCents(entries);
  return Math.round(cents / 100);
}
export function computeWeightedRate(entries: Array<{ kgUnits: number; rateCentsPerKg: number }>): {
  totalKgUnits: number;
  totalCentsBeforeRounding: number;
  weightedRateCentsPerKg: number;
  bands: Array<{ rateCentsPerKg: number; kgUnits: number }>;
} {
  let totalKgUnits = 0;
  let numerator = 0;
  const bandMap = new Map<number, number>();
  for (const e of entries) {
    totalKgUnits += e.kgUnits;
    numerator += e.kgUnits * e.rateCentsPerKg;
    bandMap.set(e.rateCentsPerKg, (bandMap.get(e.rateCentsPerKg) ?? 0) + e.kgUnits);
  }
  const totalCentsBeforeRounding = Math.floor(numerator / 10);
  const weightedRateCentsPerKg = totalKgUnits > 0 ? Math.round(numerator / totalKgUnits) : 0;
  const bands = Array.from(bandMap.entries()).map(([rateCentsPerKg, kgUnits]) => ({
    rateCentsPerKg,
    kgUnits,
  }));
  return { totalKgUnits, totalCentsBeforeRounding, weightedRateCentsPerKg, bands };
}
export function roundCentsToKesHalfUp(cents: number): number {
  return Math.floor((cents + 50) / 100) * 100;
}
