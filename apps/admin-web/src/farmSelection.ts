export type FarmChoice = { farm_id: string; name: string };

/**
 * Return the selected farm only when it still exists in the latest server list.
 * This prevents a deleted farm ID cached in browser storage from leaving the
 * Admin dashboard pointed at an empty, invisible selection.
 */
export function resolveFarmSelection(currentFarmId: string, farms: readonly FarmChoice[]): string {
  if (currentFarmId && farms.some((farm) => farm.farm_id === currentFarmId)) return currentFarmId;
  return farms[0]?.farm_id ?? "";
}
