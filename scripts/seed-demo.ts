/**
 * Seeded demo: 15 workers over 8 weeks including rehire, no-plucking day, rate change, mid-week firing
 * Used by tests and the December demo. Data is demo/demo-ephemeral labeled when USE_PGLITE=true.
 * Run: USE_PGLITE=true npx tsx scripts/seed-demo.ts  (or npm run seed)
 */

import { getDb, runMigrations } from "@tea-ledger/database";
import { generateEventId } from "@tea-ledger/core";

const FARM_NAME = "Demo Tea Farm — 15 workers, 8 weeks";
const FARM_ID = "00000000-0000-4000-a000-000000000099";

const workers = [
  { id: "00000000-0000-4000-a000-000000000101", name: "Kiptoo A", phone: "+254712000101" },
  { id: "00000000-0000-4000-a000-000000000102", name: "Chebet B", phone: "+254712000102" },
  { id: "00000000-0000-4000-a000-000000000103", name: "Kiprono C", phone: "+254712000103" },
  { id: "00000000-0000-4000-a000-000000000104", name: "Jepkemoi D", phone: "+254712000104" },
  { id: "00000000-0000-4000-a000-000000000105", name: "Koech E", phone: "+254712000105" },
  { id: "00000000-0000-4000-a000-000000000106", name: "Mutai F", phone: "+254712000106" },
  { id: "00000000-0000-4000-a000-000000000107", name: "Langat G", phone: "+254712000107" },
  { id: "00000000-0000-4000-a000-000000000108", name: "Cherono H", phone: "+254712000108" },
  { id: "00000000-0000-4000-a000-000000000109", name: "Bett I", phone: "+254712000109" },
  { id: "00000000-0000-4000-a000-000000000110", name: "Rono J", phone: "+254712000110" },
  { id: "00000000-0000-4000-a000-000000000111", name: "Ngeno K", phone: "+254712000111" },
  { id: "00000000-0000-4000-a000-000000000112", name: "Kirui L", phone: "+254712000112" },
  { id: "00000000-0000-4000-a000-000000000113", name: "Sigei M", phone: "+254712000113" },
  { id: "00000000-0000-4000-a000-000000000114", name: "Kipngetich N", phone: "+254712000114" },
  { id: "00000000-0000-4000-a000-000000000115", name: "Korir O", phone: "+254712000115" },
];

// 8 weeks: 2026-10-12 (Mon) .. 2026-12-05 (Sat) — 8 weeks
const weekStarts = [
  "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02",
  "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30",
];

function addDays(d: string, n: number): string {
  const date = new Date(d + "T12:00:00+03:00"); date.setDate(date.getDate() + n);
  return new Date(date.toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" })).toISOString().slice(0, 10); // but use our helper
}

function kgFor(workerIdx: number, dayIdx: number, weekIdx: number): number | null {
  // Deterministic but varied: 10-50kg range, some absences
  if (workerIdx === 2 && weekIdx === 3 && dayIdx === 2) return null; // absent on that day
  if (workerIdx === 7 && weekIdx === 5) return null; // absent whole week? But we have firing case below
  const base = 15 + (workerIdx * 3 + dayIdx * 2 + weekIdx) % 25;
  return base * 10; // tenths
}

async function main() {
  const db = await getDb();
  await runMigrations(db);
  console.log(`Seeding demo farm ${FARM_ID} — ${FARM_NAME}`);

  // Farm + rates
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2) ON CONFLICT (farm_id) DO NOTHING", [FARM_ID, FARM_NAME]);
  await db.query("INSERT INTO rates (farm_id, effective_from, rate_cents_per_kg) VALUES ($1,'2020-01-01',900) ON CONFLICT DO NOTHING", [FARM_ID]);
  // Rate change mid-demo: 2026-11-16 -> 1000 cents (10 KES) for weeks 6-8
  await db.query("INSERT INTO rates (farm_id, effective_from, rate_cents_per_kg) VALUES ($1,$2,$3) ON CONFLICT (farm_id, effective_from) DO UPDATE SET rate_cents_per_kg=$3", [FARM_ID, "2026-11-16", 1000]);

  const deviceId = "00000000-0000-4000-a000-000000000099";
  // Workers + employment
  for (const w of workers) {
    await db.query("INSERT INTO workers (worker_id, farm_id, full_name, phone_e164, status, verified, consent_at, consent_author) VALUES ($1,$2,$3,$4,'active',true,NOW(),'seed-demo') ON CONFLICT (worker_id) DO NOTHING", [w.id, FARM_ID, w.name, w.phone]);
    await db.query("INSERT INTO employment_periods (id, worker_id, farm_id, start_date, end_date) VALUES ($1,$2,$3,$4,null) ON CONFLICT (id) DO NOTHING", [w.id, w.id, FARM_ID, "2026-10-12"]);
  }

  // No-plucking day: 2026-11-04 (Tue of week 4) — heavy rain
  const noPluckingDate = "2026-11-04";
  await db.query("INSERT INTO plucking_days (farm_id, date, is_plucking_day, reason, confirmed, confirmed_at) VALUES ($1,$2,false,'heavy rain - no leaf',true,NOW()) ON CONFLICT (farm_id, date) DO UPDATE SET is_plucking_day=false", [FARM_ID, noPluckingDate]);
  // Rehire: worker 102 fired 2026-11-13 (Thu week 5) and rehired 2026-11-20 (Fri week 6)
  const firedWorker = workers[1].id; // Chebet B
  await db.query("UPDATE employment_periods SET end_date='2026-11-13' WHERE worker_id=$1 AND end_date IS NULL", [firedWorker]);
  // Only if we ended it, create new period for rehire
  const check = await db.query("SELECT id FROM employment_periods WHERE worker_id=$1 AND end_date='2026-11-13'", [firedWorker]);
  if ((check.rows as unknown[]).length > 0) {
    const newId = `00000000-0000-4000-a000-000000000202`;
    await db.query("INSERT INTO employment_periods (id, worker_id, farm_id, start_date, end_date) VALUES ($1,$2,$3,$4,null) ON CONFLICT (id) DO NOTHING", [newId, firedWorker, FARM_ID, "2026-11-20"]);
    await db.query("UPDATE workers SET status='active' WHERE worker_id=$1", [firedWorker]);
  }

  // Mid-week firing: worker 107 fired Wed 2026-11-25 (week 7) — still paid for Mon-Tue
  const midFired = workers[6].id; // Langat G
  // We'll log Mon/Tue then fire, but employment end inclusive 2026-11-25, so Thu+ Fri Sat not paid? Actually firing closes period on chosen end date inclusive, so plucks after firing date should be blocked. We'll log Mon/Tue before firing.

  let totalEvents = 0;
  for (let wi = 0; wi < weekStarts.length; wi++) {
    const weekStart = weekStarts[wi];
    const weekEnd = addDays(weekStart, 5);
    for (let di = 0; di < 6; di++) {
      const date = addDays(weekStart, di);
      if (date === noPluckingDate) {
        const ev = { event_id: generateEventId(), farm_id: FARM_ID, device_id: deviceId, author: "seed-demo", event_type: "day.plucking_set", payload: { date, is_plucking_day: false, reason: "heavy rain - no leaf" }, business_date: date, client_timestamp: new Date().toISOString() };
        await db.query("INSERT INTO events (event_id, farm_id, device_id, author, event_type, payload, business_date, client_timestamp) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (event_id) DO NOTHING", [ev.event_id, FARM_ID, deviceId, "seed-demo", "day.plucking_set", JSON.stringify(ev.payload), date, ev.client_timestamp]);
        totalEvents++;
        continue;
      }
      // For mid-firing week, handle firing event on Wed
      if (date === "2026-11-25" && wi === 6) {
        // Fire event for Langat G mid-week (after Tue, before Thu)
        const fireEv = { event_id: generateEventId(), farm_id: FARM_ID, device_id: deviceId, author: "seed-demo", event_type: "employment.ended", payload: { worker_id: midFired, end_date: date, reason: "mid-week firing - still paid Mon/Tue" }, business_date: date, client_timestamp: new Date().toISOString() };
        await db.query("INSERT INTO events (event_id, farm_id, device_id, author, event_type, payload, business_date, client_timestamp) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (event_id) DO NOTHING", [fireEv.event_id, FARM_ID, deviceId, "seed-demo", "employment.ended", JSON.stringify(fireEv.payload), date, fireEv.client_timestamp]);
        await db.query("UPDATE employment_periods SET end_date=$1 WHERE worker_id=$2 AND end_date IS NULL", [date, midFired]);
        await db.query("UPDATE workers SET status='inactive' WHERE worker_id=$1", [midFired]);
        totalEvents++;
      }

      for (let widx = 0; widx < workers.length; widx++) {
        const w = workers[widx];
        // Skip fired workers on dates after firing
        if (w.id === midFired && date > "2026-11-25") continue;
        if (w.id === firedWorker && date > "2026-11-13" && date < "2026-11-20") continue; // gap between fire and rehire
        const kgUnits = kgFor(widx, di, wi);
        if (kgUnits === null) {
          // Absent: present false
          const ev = { event_id: generateEventId(), farm_id: FARM_ID, device_id: deviceId, author: "seed-demo", event_type: "pluck.logged", payload: { worker_id: w.id, kg_units: null, present: false }, business_date: date, client_timestamp: new Date().toISOString() };
          await db.query("INSERT INTO events (event_id, farm_id, device_id, author, event_type, payload, business_date, client_timestamp) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (event_id) DO NOTHING", [ev.event_id, FARM_ID, deviceId, "seed-demo", "pluck.logged", JSON.stringify(ev.payload), date, ev.client_timestamp]);
          totalEvents++;
        } else {
          const ev = { event_id: generateEventId(), farm_id: FARM_ID, device_id: deviceId, author: "seed-demo", event_type: "pluck.logged", payload: { worker_id: w.id, kg_units: kgUnits, present: true }, business_date: date, client_timestamp: new Date().toISOString() };
          await db.query("INSERT INTO events (event_id, farm_id, device_id, author, event_type, payload, business_date, client_timestamp) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (event_id) DO NOTHING", [ev.event_id, FARM_ID, deviceId, "seed-demo", "pluck.logged", JSON.stringify(ev.payload), date, ev.client_timestamp]);
          totalEvents++;
        }
      }
      // Day confirmed each day for demo
      const dayEv = { event_id: generateEventId(), farm_id: FARM_ID, device_id: deviceId, author: "seed-demo", event_type: "day.confirmed", payload: { date }, business_date: date, client_timestamp: new Date().toISOString() };
      await db.query("INSERT INTO events (event_id, farm_id, device_id, author, event_type, payload, business_date, client_timestamp) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (event_id) DO NOTHING", [dayEv.event_id, FARM_ID, deviceId, "seed-demo", "day.confirmed", JSON.stringify(dayEv.payload), date, dayEv.client_timestamp]);
      totalEvents++;
    }
    // Week submitted Saturday
    const weekEv = { event_id: generateEventId(), farm_id: FARM_ID, device_id: deviceId, author: "seed-demo", event_type: "week.submitted", payload: {}, business_date: weekEnd, client_timestamp: new Date().toISOString() };
    await db.query("INSERT INTO events (event_id, farm_id, device_id, author, event_type, payload, business_date, client_timestamp) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (event_id) DO NOTHING", [weekEv.event_id, FARM_ID, deviceId, "seed-demo", "week.submitted", JSON.stringify(weekEv.payload), weekEnd, weekEv.client_timestamp]);
    await db.query("INSERT INTO pay_weeks (farm_id, week_start, week_end, status, locked_at) VALUES ($1,$2,$3,'locked',NOW()) ON CONFLICT (farm_id, week_start) DO UPDATE SET status='locked', locked_at=NOW()", [FARM_ID, weekStart, weekEnd]);
    totalEvents++;
  }

  // Owner/supervisor phones in settings
  await db.query("INSERT INTO farm_settings (farm_id, settings) VALUES ($1,$2::jsonb) ON CONFLICT (farm_id) DO UPDATE SET settings=$2::jsonb", [FARM_ID, JSON.stringify({ ownerPhone: "+254712000000", supervisorPhone: "+254712000099", fridayEstimateTime: "17:00" })]);

  console.log(`Seeded ${totalEvents} events for 8 weeks, 15 workers. Rate change 2026-11-16, no-plucking ${noPluckingDate}, rehire ${firedWorker}, mid-week fire 2026-11-25 ${midFired}`);
  console.log(`Farm ${FARM_ID} ready. Payroll example: GET /api/farms/${FARM_ID}/payroll/2026-11-23?format=html`);
  if ((await import("@tea-ledger/database").then(m => m.getDb).catch(()=>null))) {
    // close handled by getDb pool? Not needed for PGlite demo
  }
}

main().catch(e => { console.error(e); process.exit(1); });
