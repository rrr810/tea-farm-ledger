import { getDb } from "./db.js";
import { normalizeKePhone } from "@tea-ledger/core";

export type WorkerRow = {
  worker_id: string;
  farm_id: string;
  full_name: string;
  phone_e164: string | null;
  status: string;
  verified: boolean;
  consent_at: string | null;
  consent_author: string | null;
};

export async function createWorker(opts: { farmId: string; fullName: string; phone: string; consentAuthor: string; dbClient?: Awaited<ReturnType<typeof getDb>> }) {
  const db = opts.dbClient ?? (await getDb());
  const norm = normalizeKePhone(opts.phone);
  if (!norm.ok) throw new Error(`invalid phone: ${norm.reason}`);
  const e164 = norm.e164;
  // Check active holder for this phone (Decision 17)
  const existing = await db.query("SELECT worker_id, status FROM workers WHERE farm_id=$1 AND phone_e164=$2 AND status='active'", [opts.farmId, e164]);
  if ((existing.rows as unknown[]).length > 0) {
    const holder = (existing.rows as Array<{ worker_id: string }>)[0];
    throw new Error(`phone ${e164} belongs to active worker ${holder.worker_id} — end that worker first`);
  }
  const workerId = crypto.randomUUID();
  await db.query(
    "INSERT INTO workers (worker_id, farm_id, full_name, phone_e164, status, verified, consent_at, consent_author) VALUES ($1,$2,$3,$4,'active',false,NOW(),$5)",
    [workerId, opts.farmId, opts.fullName, e164, opts.consentAuthor]
  );
  return { worker_id: workerId, phone_e164: e164 };
}

export async function listWorkers(farmId: string, dbClient?: Awaited<ReturnType<typeof getDb>>) {
  const db = dbClient ?? (await getDb());
  const res = await db.query("SELECT * FROM workers WHERE farm_id=$1 ORDER BY created_at ASC", [farmId]);
  return res.rows as WorkerRow[];
}

export async function startEmployment(period: { workerId: string; farmId: string; startDate: string; dbClient?: Awaited<ReturnType<typeof getDb>> }) {
  const db = period.dbClient ?? (await getDb());
  // Check inclusive overlap
  const existing = await db.query("SELECT * FROM employment_periods WHERE worker_id=$1 ORDER BY start_date ASC", [period.workerId]);
  const periods = existing.rows as Array<{ start_date: string; end_date: string | null }>;
  const lastEnded = periods.filter(p=> p.end_date !== null).sort((a,b)=> (a.end_date as string).localeCompare(b.end_date as string)).pop();
  if (periods.some(p=> p.end_date === null)) throw new Error("already active");
  if (lastEnded && period.startDate <= (lastEnded.end_date as string)) throw new Error(`start ${period.startDate} must be after previous end ${lastEnded.end_date} inclusive`);
  const id = crypto.randomUUID();
  await db.query("INSERT INTO employment_periods (id, worker_id, farm_id, start_date, end_date) VALUES ($1,$2,$3,$4,null)", [id, period.workerId, period.farmId, period.startDate]);
  return { id };
}

export async function endEmployment(opts: { workerId: string; endDate: string; reason?: string; dbClient?: Awaited<ReturnType<typeof getDb>> }) {
  const db = opts.dbClient ?? (await getDb());
  const res = await db.query("SELECT id, start_date FROM employment_periods WHERE worker_id=$1 AND end_date IS NULL", [opts.workerId]);
  if ((res.rows as unknown[]).length === 0) throw new Error("no active period");
  const active = (res.rows as Array<{ id: string; start_date: string }>)[0];
  if (opts.endDate < active.start_date) throw new Error("end before start");
  await db.query("UPDATE employment_periods SET end_date=$1, end_reason=$2 WHERE id=$3", [opts.endDate, opts.reason ?? null, active.id]);
  await db.query("UPDATE workers SET status='inactive' WHERE worker_id=$1", [opts.workerId]);
  return { id: active.id };
}

export async function listEmployment(workerId: string, dbClient?: Awaited<ReturnType<typeof getDb>>) {
  const db = dbClient ?? (await getDb());
  const res = await db.query("SELECT * FROM employment_periods WHERE worker_id=$1 ORDER BY start_date ASC", [workerId]);
  return res.rows;
}
