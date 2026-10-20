import { getDb } from "./db.js";
import type { LedgerEvent } from "@tea-ledger/core";
export type PushResult = {
  accepted: number;
  duplicates: number;
  flaggedAsCorrection: number;
  conflicts: number;
};
export async function pushEvents(events: LedgerEvent[], dbClient?: Awaited<ReturnType<typeof getDb>>): Promise<PushResult> {
  const db = dbClient ?? (await getDb());
  let accepted = 0; let duplicates = 0; let flaggedAsCorrection = 0; let conflicts = 0;
  for (const ev of events) {
    const exists = await db.query("SELECT event_id FROM events WHERE event_id = $1", [ev.event_id]);
    if ((exists.rows as unknown[]).length > 0) { duplicates++; continue; }
    const weekStart = getWeekStart(ev.business_date);
    const weekEnd = getWeekEnd(weekStart);
    const lockedCheck = await db.query("SELECT status FROM pay_weeks WHERE farm_id = $1 AND week_start = $2", [ev.farm_id, weekStart]);
    const isLocked = (lockedCheck.rows as Array<{ status: string }>)[0]?.status === "locked";
    let correctionFlag = false; let conflictFlag = false;
    if (isLocked && !["week.submitted", "correction.requested"].includes(ev.event_type)) {
      correctionFlag = true; flaggedAsCorrection++;
    }
    if (ev.event_type === "pluck.logged") {
      const workerId = (ev.payload as { worker_id?: string }).worker_id;
      if (workerId) {
        const dupDay = await db.query(
          "SELECT event_id FROM events WHERE farm_id = $1 AND payload->>'worker_id' = $2 AND business_date = $3 AND event_type = 'pluck.logged' LIMIT 1",
          [ev.farm_id, workerId, ev.business_date],
        );
        if ((dupDay.rows as unknown[]).length > 0) { conflictFlag = true; conflicts++; }
      }
    }
    await db.query(
      `INSERT INTO events (event_id, farm_id, device_id, author, event_type, payload, business_date, client_timestamp, server_received_at, correction_flag, conflict_flag)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,NOW(),$9,$10)
       ON CONFLICT (event_id) DO NOTHING`,
      [ev.event_id, ev.farm_id, ev.device_id ?? null, ev.author, ev.event_type, JSON.stringify(ev.payload), ev.business_date, ev.client_timestamp, correctionFlag, conflictFlag],
    );
    accepted++;
    if (ev.event_type === "week.submitted") {
      await db.query(
        `INSERT INTO pay_weeks (farm_id, week_start, week_end, status, locked_at)
         VALUES ($1,$2,$3,'locked',NOW())
         ON CONFLICT (farm_id, week_start) DO UPDATE SET status='locked', locked_at=NOW()`,
        [ev.farm_id, weekStart, weekEnd],
      );
    }
  }
  return { accepted, duplicates, flaggedAsCorrection, conflicts };
}
export type PullResult = { events: LedgerEvent[]; nextCursor: number | null; };
export async function pullEvents(sinceCursor: number | null, farmId: string, limit = 100, dbClient?: Awaited<ReturnType<typeof getDb>>): Promise<PullResult> {
  const db = dbClient ?? (await getDb());
  const cursor = sinceCursor ?? 0;
  const res = await db.query(
    `SELECT event_id, farm_id, device_id, author, event_type, payload, business_date, client_timestamp, server_received_at, seq
     FROM events WHERE farm_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
    [farmId, cursor, limit],
  );
  const rows = res.rows as Array<{
    event_id: string; farm_id: string; device_id: string | null; author: string; event_type: string; payload: unknown; business_date: string; client_timestamp: string; server_received_at: string; seq: number;
  }>;
  const events: LedgerEvent[] = rows.map((r) => ({
    event_id: r.event_id, farm_id: r.farm_id, device_id: r.device_id ?? undefined, author: r.author, event_type: r.event_type, payload: r.payload as Record<string, unknown>,
    business_date: typeof r.business_date === "string" ? r.business_date.slice(0, 10) : new Date(r.business_date).toISOString().slice(0, 10),
    client_timestamp: new Date(r.client_timestamp).toISOString(),
    server_received_at: r.server_received_at ? new Date(r.server_received_at).toISOString() : undefined,
    seq: r.seq,
  }));
  const nextCursor = rows.length > 0 ? rows[rows.length - 1].seq : cursor;
  const hasMore = rows.length === limit;
  return { events, nextCursor: hasMore ? nextCursor : null };
}
function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00+03:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return toYMD(d);
}
function getWeekEnd(weekStart: string): string {
  const d = new Date(weekStart + "T12:00:00+03:00");
  d.setDate(d.getDate() + 5);
  return toYMD(d);
}
function toYMD(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${day}`;
}
