import type { FastifyInstance } from "fastify";
import { getDb } from "@tea-ledger/database";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

// Simple password hashing: SHA256(salt + password) — adequate for Phase 1 pilot, replace with bcrypt in hardening if needed
// We store hash as "salt:hash"
function hashPassword(password: string, salt = randomUUID().slice(0, 16)): string {
  const h = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${h}`;
}
function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const h = createHash("sha256").update(salt + password).digest("hex");
  return h === hash;
}

function sessionToken(): string {
  return randomUUID() + "-" + randomUUID();
}

export async function adminRoutes(app: FastifyInstance) {
  // Ensure default admin user exists on first call (idempotent)
  async function ensureAdmin() {
    const db = await getDb();
    const adminUser = process.env.ADMIN_USERNAME ?? "admin";
    const adminPass = process.env.ADMIN_DEFAULT_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "tea-admin-2026";
    const res = await db.query("SELECT user_id, password_hash FROM users WHERE username=$1", [adminUser]);
    if ((res.rows as unknown[]).length > 0) return res.rows[0] as { user_id: string; password_hash: string };
    // Need a farm to attach? Create default farm if none
    const farms = await db.query("SELECT farm_id FROM farms LIMIT 1");
    let farmId: string;
    if ((farms.rows as unknown[]).length === 0) {
      farmId = randomUUID();
      await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [farmId, "Default Farm"]);
      await db.query("INSERT INTO rates (farm_id, effective_from, rate_cents_per_kg) VALUES ($1,'2020-01-01',900) ON CONFLICT DO NOTHING", [farmId]);
    } else {
      farmId = (farms.rows as Array<{ farm_id: string }>)[0].farm_id;
    }
    const userId = randomUUID();
    const hash = hashPassword(adminPass);
    await db.query("INSERT INTO users (user_id, farm_id, role, username, password_hash) VALUES ($1,$2,'admin',$3,$4)", [userId, farmId, adminUser, hash]);
    return { user_id: userId, password_hash: hash };
  }

  // POST /api/admin/login {username, password} -> {token, user_id, role}
  app.post("/api/admin/login", async (req, reply) => {
    const body = req.body as { username?: string; password?: string };
    if (!body.username || !body.password) return reply.status(400).send({ error: "username and password required" });
    await ensureAdmin();
    const db = await getDb();
    const res = await db.query("SELECT user_id, farm_id, role, password_hash FROM users WHERE username=$1", [body.username]);
    const user = (res.rows as Array<{ user_id: string; farm_id: string; role: string; password_hash: string }>)[0];
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      return reply.status(401).send({ error: "invalid credentials" });
    }
    const token = sessionToken();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(); // 7d
    await db.query("INSERT INTO sessions (token, user_id, farm_id, role, expires_at) VALUES ($1,$2,$3,$4,$5)", [token, user.user_id, user.farm_id, user.role, expiresAt]);
    return { ok: true, token, user_id: user.user_id, farm_id: user.farm_id, role: user.role, expires_at: expiresAt };
  });

  // GET /api/admin/me (token via Authorization Bearer)
  app.get("/api/admin/me", async (req, reply) => {
    const auth = (req.headers.authorization as string) ?? "";
    const token = auth.replace(/^Bearer\s+/i, "") || (req.query as { token?: string }).token;
    if (!token) return reply.status(401).send({ error: "unauthorized" });
    const db = await getDb();
    const res = await db.query("SELECT s.token, s.expires_at, u.username, u.role, u.farm_id FROM sessions s JOIN users u ON s.user_id=u.user_id WHERE s.token=$1", [token]);
    const row = (res.rows as Array<{ token: string; expires_at: string; username: string; role: string; farm_id: string }>)[0];
    if (!row) return reply.status(401).send({ error: "invalid token" });
    if (new Date(row.expires_at) < new Date()) return reply.status(401).send({ error: "token expired" });
    return { ok: true, username: row.username, role: row.role, farm_id: row.farm_id };
  });

  // POST /api/admin/logout
  app.post("/api/admin/logout", async (req) => {
    const auth = (req.headers.authorization as string) ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (token) {
      const db = await getDb();
      await db.query("DELETE FROM sessions WHERE token=$1", [token]);
    }
    return { ok: true };
  });

  // GET /api/farms/:farmId/audit-log?limit=
  app.get("/api/farms/:farmId/audit-log", async (req) => {
    const { farmId } = req.params as { farmId: string };
    const qs = req.query as { limit?: string };
    const limit = qs.limit ? Math.min(Number(qs.limit), 200) : 100;
    const db = await getDb();
    const res = await db.query("SELECT * FROM audit_log WHERE farm_id=$1 ORDER BY created_at DESC LIMIT $2", [farmId, limit]);
    return { logs: res.rows, count: res.rows.length };
  });

  // GET /api/farms/:farmId/reports/monthly?months=6
  app.get("/api/farms/:farmId/reports/monthly", async (req) => {
    const { farmId } = req.params as { farmId: string };
    const qs = req.query as { months?: string };
    const months = qs.months ? Math.min(Number(qs.months), 24) : 6;
    const db = await getDb();
    // Aggregate pluck events by month (business_date truncated to YYYY-MM)
    const res = await db.query(
      `SELECT
         to_char(business_date, 'YYYY-MM') as month,
         COUNT(DISTINCT payload->>'worker_id') as active_workers,
         SUM((payload->>'kg_units')::int) as total_kg_units,
         COUNT(*) as entries
       FROM events
       WHERE farm_id=$1 AND event_type='pluck.logged' AND (payload->>'present') != 'false'
       GROUP BY month ORDER BY month ASC`,
      [farmId],
    );
    const rows = res.rows as Array<{ month: string; active_workers: string; total_kg_units: string | null; entries: string }>;
    // Also payroll totals per month from payroll_lines (group by week_start month)
    const payRes = await db.query(
      `SELECT to_char(week_start, 'YYYY-MM') as month, SUM(amount_cents) as total_cents, COUNT(*) as lines
       FROM payroll_lines WHERE farm_id=$1 GROUP BY month ORDER BY month ASC`,
      [farmId],
    );
    const payRows = payRes.rows as Array<{ month: string; total_cents: string | null; lines: string }>;
    const payMap = new Map(payRows.map((r) => [r.month, r]));
    const combined = rows.map((r) => ({
      month: r.month,
      total_kg: r.total_kg_units ? Number(r.total_kg_units) / 10 : 0,
      active_workers: Number(r.active_workers),
      entries: Number(r.entries),
      payroll_kes: payMap.get(r.month) ? Math.round(Number(payMap.get(r.month)!.total_cents ?? 0) / 100) : 0,
    }));
    // Fill empty months for rolling view: last `months` months including current
    return { monthly: combined.slice(-months), payroll_monthly: payRows };
  });

  // GET /api/farms/:farmId/reports/active-idle?yearMonth=2026-11
  app.get("/api/farms/:farmId/reports/active-idle", async (req) => {
    const { farmId } = req.params as { farmId: string };
    const qs = req.query as { month?: string; year?: string; year_month?: string };
    const yearMonth = qs.year_month ?? qs.month ?? new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" }).slice(0, 7);
    const db = await getDb();
    // Active = at least one plucking-day entry in month
    // Idle = employed for some/all of month but no attended plucking day
    // We need employment periods and plucks per month
    const workersRes = await db.query("SELECT worker_id, full_name FROM workers WHERE farm_id=$1", [farmId]);
    const workers = workersRes.rows as Array<{ worker_id: string; full_name: string }>;
    const result: Array<{ worker_id: string; name: string; status: "active" | "idle" }> = [];
    for (const w of workers) {
      const epRes = await db.query("SELECT start_date, end_date FROM employment_periods WHERE worker_id=$1", [w.worker_id]);
      const periods = epRes.rows as Array<{ start_date: string; end_date: string | null }>;
      const monthStart = `${yearMonth}-01`;
      const monthEndDate = new Date(yearMonth + "-01T12:00:00+03:00");
      monthEndDate.setMonth(monthEndDate.getMonth() + 1);
      monthEndDate.setDate(0);
      const monthEnd = monthEndDate.toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
      // Check employed in month: any period overlapping month
      let employedInMonth = false;
      for (const p of periods) {
        const ps = typeof p.start_date === "string" ? p.start_date.slice(0, 10) : new Date(p.start_date).toISOString().slice(0, 10);
        const pe = p.end_date ? (typeof p.end_date === "string" ? p.end_date.slice(0, 10) : new Date(p.end_date).toISOString().slice(0, 10)) : "9999-12-31";
        if (ps <= monthEnd && pe >= monthStart) employedInMonth = true;
      }
      if (!employedInMonth) continue;
      // Check active: any plucking-day entry in month where present
      const pluckRes = await db.query(
        `SELECT 1 FROM events WHERE farm_id=$1 AND payload->>'worker_id'=$2 AND business_date >= $3 AND business_date <= $4 AND event_type='pluck.logged' AND (payload->>'present') != 'false' LIMIT 1`,
        [farmId, w.worker_id, monthStart, monthEnd],
      );
      const active = (pluckRes.rows as unknown[]).length > 0;
      result.push({ worker_id: w.worker_id, name: w.full_name, status: active ? "active" : "idle" });
    }
    const activeCount = result.filter((r) => r.status === "active").length;
    const idleCount = result.filter((r) => r.status === "idle").length;
    return { month: yearMonth, active: activeCount, idle: idleCount, details: result };
  });

  // GET /api/farms/:farmId/reports/hardest-working?quarter=2026-Q4
  app.get("/api/farms/:farmId/reports/hardest-working", async (req) => {
    const { farmId } = req.params as { farmId: string };
    const qs = req.query as { quarter?: string; year?: string; q?: string };
    let quarter = qs.quarter ?? qs.q;
    let year: number, q: number;
    if (quarter) {
      const m = quarter.match(/(\d{4})-Q(\d)/);
      if (m) {
        year = Number(m[1]);
        q = Number(m[2]);
      } else {
        year = new Date().getFullYear();
        q = Math.floor(new Date().getMonth() / 3) + 1;
      }
    } else {
      year = Number(qs.year) || new Date().getFullYear();
      q = Math.floor(new Date().getMonth() / 3) + 1;
    }
    const quarterStartMonth = (q - 1) * 3 + 1;
    const quarterStart = `${year}-${String(quarterStartMonth).padStart(2, "0")}-01`;
    const quarterEndDate = new Date(quarterStart + "T12:00:00+03:00");
    quarterEndDate.setMonth(quarterEndDate.getMonth() + 3);
    quarterEndDate.setDate(0);
    const quarterEnd = quarterEndDate.toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });

    const db = await getDb();
    // Per-worker aggregates in quarter
    const res = await db.query(
      `SELECT
         payload->>'worker_id' as wid,
         COUNT(DISTINCT business_date) as days_attended,
         SUM((payload->>'kg_units')::int) as kg_units,
         COUNT(*) as entries
       FROM events
       WHERE farm_id=$1 AND event_type='pluck.logged' AND (payload->>'present') != 'false'
         AND business_date >= $2 AND business_date <= $3
       GROUP BY wid`,
      [farmId, quarterStart, quarterEnd],
    );
    const rows = res.rows as Array<{ wid: string; days_attended: string; kg_units: string | null; entries: string }>;
    // Also need attendance denominator: plucking days during active employment
    const workersRes = await db.query("SELECT worker_id, full_name FROM workers WHERE farm_id=$1", [farmId]);
    const nameMap = new Map((workersRes.rows as Array<{ worker_id: string; full_name: string }>).map((r) => [r.worker_id, r.full_name]));
    const ranked: Array<{
      worker_id: string;
      name: string;
      total_kg: number;
      avg_kg_per_day: number;
      days_attended: number;
      attendance_rate: number | null;
      attendance_denom: number;
    }> = [];
    for (const r of rows) {
      const wid = r.wid;
      const totalKgUnits = Number(r.kg_units ?? 0);
      const daysAttended = Number(r.days_attended);
      const totalKg = totalKgUnits / 10;
      const avg = daysAttended > 0 ? totalKg / daysAttended : 0;
      // Attendance denominator: count plucking days in quarter where worker was employed
      const epRes = await db.query("SELECT start_date, end_date FROM employment_periods WHERE worker_id=$1", [wid]);
      const periods = epRes.rows as Array<{ start_date: string; end_date: string | null }>;
      // Count plucking_days in quarter where employed
      const pdRes = await db.query("SELECT date, is_plucking_day FROM plucking_days WHERE farm_id=$1 AND date >= $2 AND date <= $3", [farmId, quarterStart, quarterEnd]);
      let denom = 0;
      for (const pd of pdRes.rows as Array<{ date: string; is_plucking_day: boolean }>) {
        if (!pd.is_plucking_day) continue;
        const d = typeof pd.date === "string" ? pd.date.slice(0, 10) : new Date(pd.date).toISOString().slice(0, 10);
        // Check employed on that date
        let employed = false;
        for (const p of periods) {
          const ps = typeof p.start_date === "string" ? p.start_date.slice(0, 10) : new Date(p.start_date).toISOString().slice(0, 10);
          const pe = p.end_date ? (typeof p.end_date === "string" ? p.end_date.slice(0, 10) : new Date(p.end_date).toISOString().slice(0, 10)) : "9999-12-31";
          if (d >= ps && d <= pe) employed = true;
        }
        if (employed) denom++;
      }
      // Fallback: if no plucking_days entries, assume Mon-Sat all plucking (approx)
      if (denom === 0 && daysAttended > 0) denom = daysAttended; // avoid 0
      const attendanceRate = denom > 0 ? daysAttended / denom : null;
      ranked.push({
        worker_id: wid,
        name: nameMap.get(wid) ?? wid.slice(0, 6),
        total_kg: totalKg,
        avg_kg_per_day: Math.round(avg * 10) / 10,
        days_attended: daysAttended,
        attendance_rate: attendanceRate,
        attendance_denom: denom,
      });
    }
    ranked.sort((a, b) => b.total_kg - a.total_kg);
    return {
      quarter: `${year}-Q${q}`,
      quarter_start: quarterStart,
      quarter_end: quarterEnd,
      note: "kg does not reflect leaf quality — ranking only",
      ranking: ranked,
    };
  });

  // CSV import: canonical template
  // GET /api/farms/:farmId/csv-template
  app.get("/api/farms/:farmId/csv-template", async () => {
    const csv = `worker_id,full_name,phone_e164,business_date,kg_units,present,is_plucking_day,rate_cents_per_kg
EXAMPLE,Example Worker,+254712345678,2026-11-23,400,true,true,900
# kg_units is integer tenths (e.g. 400 = 40.0kg), present true/false, is_plucking_day true/false`;
    return { template: csv, filename: "tea-ledger-import-template.csv" };
  });

  // POST /api/farms/:farmId/csv-import/preview {csv: string}
  app.post("/api/farms/:farmId/csv-import/preview", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const body = req.body as { csv?: string; csv_text?: string };
    const csv = body.csv ?? body.csv_text;
    if (!csv) return reply.status(400).send({ error: "csv required" });
    const lines = csv.trim().split(/\r?\n/).filter((l: string) => l.trim() && !l.trim().startsWith("#"));
    if (lines.length < 2) return reply.status(400).send({ error: "csv needs header + at least 1 row" });
    const header = lines[0].split(",").map((s: string) => s.trim());
    const expected = ["worker_id", "full_name", "phone_e164", "business_date", "kg_units", "present", "is_plucking_day"];
    const missing = expected.filter((e) => !header.includes(e));
    if (missing.length) return reply.status(400).send({ error: `missing columns: ${missing.join(", ")}` });
    const idx: Record<string, number> = {};
    header.forEach((h: string, i: number) => (idx[h] = i));
    const errors: Array<{ row: number; error: string }> = [];
    const preview: unknown[] = [];
    const seen = new Set<string>();
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((s: string) => s.trim());
      const worker_id = cols[idx["worker_id"]];
      const business_date = cols[idx["business_date"]];
      const key = `${worker_id}:${business_date}`;
      if (seen.has(key)) {
        errors.push({ row: i + 1, error: `duplicate worker_id+date ${key} — duplicates rejected for explicit resolution` });
        continue;
      }
      seen.add(key);
      if (!worker_id) errors.push({ row: i + 1, error: "worker_id required" });
      if (!business_date || !/^\d{4}-\d{2}-\d{2}$/.test(business_date)) errors.push({ row: i + 1, error: "business_date must be YYYY-MM-DD" });
      preview.push({ row: i + 1, worker_id, business_date, kg_units: cols[idx["kg_units"]], present: cols[idx["present"]] });
    }
    // Check already existing events for duplicates
    const db = await getDb();
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((s: string) => s.trim());
      const worker_id = cols[idx["worker_id"]];
      const business_date = cols[idx["business_date"]];
      if (!worker_id || !business_date) continue;
      const dup = await db.query("SELECT event_id FROM events WHERE farm_id=$1 AND payload->>'worker_id'=$2 AND business_date=$3 AND event_type='pluck.logged' LIMIT 1", [farmId, worker_id, business_date]);
      if ((dup.rows as unknown[]).length > 0) {
        errors.push({ row: i + 1, error: `already exists on server for ${worker_id} on ${business_date} — duplicate rejected` });
      }
    }
    return { preview, errors, valid: errors.length === 0, total_rows: lines.length - 1 };
  });

  // POST /api/farms/:farmId/csv-import/commit {csv: string}
  app.post("/api/farms/:farmId/csv-import/commit", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const body = req.body as { csv?: string; csv_text?: string };
    const csv = body.csv ?? body.csv_text;
    if (!csv) return reply.status(400).send({ error: "csv required" });
    const lines = csv.trim().split(/\r?\n/).filter((l: string) => l.trim() && !l.trim().startsWith("#"));
    const header = lines[0].split(",").map((s: string) => s.trim());
    const idx: Record<string, number> = {};
    header.forEach((h: string, i: number) => (idx[h] = i));
    const db = await getDb();
    let imported = 0;
    const deviceId = randomUUID();
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((s: string) => s.trim());
      const worker_id = cols[idx["worker_id"]];
      const full_name = cols[idx["full_name"]] ?? worker_id;
      const phone_e164 = cols[idx["phone_e164"]] ?? "";
      const business_date = cols[idx["business_date"]];
      const kg_units = cols[idx["kg_units"]] ? Number(cols[idx["kg_units"]]) : null;
      const present = cols[idx["present"]] ? cols[idx["present"]] === "true" : true;
      const is_plucking_day = cols[idx["is_plucking_day"]] ? cols[idx["is_plucking_day"]] === "true" : true;
      const rate_cents = cols[idx["rate_cents_per_kg"]] ? Number(cols[idx["rate_cents_per_kg"]]) : null;
      // Ensure worker exists
      const wRes = await db.query("SELECT worker_id FROM workers WHERE worker_id=$1", [worker_id]);
      if ((wRes.rows as unknown[]).length === 0) {
        await db.query("INSERT INTO workers (worker_id, farm_id, full_name, phone_e164, status, verified, consent_at, consent_author) VALUES ($1,$2,$3,$4,'active',false,NOW(),'csv-import')", [worker_id, farmId, full_name, phone_e164 || null]);
        await db.query("INSERT INTO employment_periods (id, worker_id, farm_id, start_date, end_date) VALUES ($1,$2,$3,$4,null)", [randomUUID(), worker_id, farmId, business_date]);
      }
      // Insert event
      const eventId = randomUUID();
      await db.query(
        `INSERT INTO events (event_id, farm_id, device_id, author, event_type, payload, business_date, client_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,NOW()) ON CONFLICT (event_id) DO NOTHING`,
        [eventId, farmId, deviceId, "csv-import", "pluck.logged", JSON.stringify({ worker_id, kg_units, present, is_plucking_day, rate_cents_per_kg: rate_cents }), business_date],
      );
      // Also plucking_days
      if (!is_plucking_day) {
        await db.query(`INSERT INTO plucking_days (farm_id, date, is_plucking_day, reason, confirmed) VALUES ($1,$2,false,'csv no plucking',true) ON CONFLICT (farm_id, date) DO NOTHING`, [farmId, business_date]);
      }
      imported++;
    }
    await db.query(`INSERT INTO audit_log (farm_id, actor, action, target, detail) VALUES ($1,$2,$3,$4,$5::jsonb)`, [farmId, "admin", "csv.import", null, JSON.stringify({ imported, rows: lines.length - 1 })]);
    return { ok: true, imported };
  });

  // GET /api/farms/:farmId/export/workers?format=csv
  app.get("/api/farms/:farmId/export/workers", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const db = await getDb();
    const res = await db.query("SELECT worker_id, full_name, phone_e164, status, verified FROM workers WHERE farm_id=$1 ORDER BY created_at ASC", [farmId]);
    const csvRows = ["worker_id,full_name,phone_e164,status,verified"];
    for (const r of res.rows as Array<{ worker_id: string; full_name: string; phone_e164: string | null; status: string; verified: boolean }>) {
      csvRows.push(`${r.worker_id},"${r.full_name.replace(/"/g, '""')}",${r.phone_e164 ?? ""},${r.status},${r.verified}`);
    }
    const csv = csvRows.join("\n");
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="workers-${farmId}.csv"`);
    return reply.send(csv);
  });
}
