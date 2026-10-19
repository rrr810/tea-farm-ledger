import { getDb } from "./db.js";
export async function listUnresolvedConflicts(farmId: string, dbClient?: Awaited<ReturnType<typeof getDb>>) {
  const db = dbClient ?? (await getDb());
  const res = await db.query("SELECT * FROM events WHERE farm_id = $1 AND conflict_flag = true ORDER BY seq DESC", [farmId]);
  return res.rows;
}
export async function listCorrectionRequests(farmId: string, dbClient?: Awaited<ReturnType<typeof getDb>>) {
  const db = dbClient ?? (await getDb());
  const res = await db.query("SELECT * FROM events WHERE farm_id = $1 AND correction_flag = true ORDER BY seq DESC", [farmId]);
  return res.rows;
}
