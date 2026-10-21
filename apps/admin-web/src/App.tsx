import { useEffect, useState } from "react";
import { api, token, setToken, clearToken, farmId, setFarmId } from "./api.js";

type Tab = "login" | "dashboard" | "workers" | "payroll" | "conflicts" | "sms" | "reports" | "import" | "settings" | "audit";

// ---- reporting helpers (quarter math + lightweight SVG charts, no deps) ----
function quarterLabel(d = new Date()): string {
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}
function lastQuarters(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(quarterLabel(d));
    d.setMonth(d.getMonth() - 3);
  }
  return out;
}
function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: "#FFFDF6", border: "1px solid #D9D2BC", borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, letterSpacing: 0.8, textTransform: "uppercase", color: "#4A4A42", fontWeight: 700 }}>{label}</div>
      <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 20, fontWeight: 700, color: "#1F4D2B", margin: "4px 0 2px" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#6B6B5E" }}>{sub}</div>}
    </div>
  );
}
function BarChart({ data, color }: { data: Array<{ label: string; value: number }>; color: string }) {
  if (data.length === 0) return <p style={{ fontSize: 12, color: "#6B6B5E" }}>No data yet.</p>;
  const w = 560, h = 190, pad = 30;
  const max = Math.max(1, ...data.map(d => d.value));
  const slot = (w - pad * 2) / data.length;
  const bw = Math.min(56, slot - 10);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", maxWidth: 640, display: "block" }} role="img">
      <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#D9D2BC" strokeWidth="1.5" />
      {data.map((d, i) => {
        const bh = Math.max(2, Math.round(((h - pad * 2) * d.value) / max));
        const x = pad + i * slot + (slot - bw) / 2;
        const y = h - pad - bh;
        return (
          <g key={d.label}>
            <rect x={x} y={y} width={bw} height={bh} rx="6" fill={color} />
            <text x={x + bw / 2} y={y - 6} textAnchor="middle" fontSize="11" fontWeight={700} fill="#23231F">{d.value.toLocaleString()}</text>
            <text x={x + bw / 2} y={h - pad + 15} textAnchor="middle" fontSize="11" fill="#4A4A42">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>(token() ? "dashboard" : "login");
  const [msg, setMsg] = useState("");

  // login state
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [farms, setFarms] = useState<Array<{ farm_id: string; name: string }>>([]);
  const [currentFarm, setCurrentFarm] = useState(farmId());

  // data
  const [workers, setWorkers] = useState<unknown[]>([]);
  const [payrollWeeks, setPayrollWeeks] = useState<unknown[]>([]);
  const [payrollSheet, setPayrollSheet] = useState<null | { sheet: { weekStart: string; weekEnd: string; status: string; lines: Array<{ name: string; totalKg: number; amountKes: number; flags: string[]; maskedPhone: string; daysWorked: number }>; totals: { totalKg: number; totalAmountKes: number } } }>(null);
  const [weekStart, setWeekStart] = useState("2026-11-23");
  const [conflicts, setConflicts] = useState<unknown[]>([]);
  const [corrections, setCorrections] = useState<unknown[]>([]);
  const [smsLog, setSmsLog] = useState<unknown[]>([]);
  const [monthly, setMonthly] = useState<unknown[]>([]);
  const [hardest, setHardest] = useState<unknown[]>([]);
  const [quarter, setQuarter] = useState(() => quarterLabel());
  const [audit, setAudit] = useState<unknown[]>([]);
  const [rates, setRates] = useState<unknown[]>([]);
  const [csvText, setCsvText] = useState("worker_id,full_name,phone_e164,business_date,kg_units,present,is_plucking_day\n");
  const [csvPreview, setCsvPreview] = useState<unknown>(null);

  function toast(m: string) { setMsg(m); setTimeout(() => setMsg(""), 4000); }

  async function doLogin() {
    try {
      const res = await api.login(username, password) as { token: string; farm_id: string };
      setToken(res.token); setFarmId(res.farm_id); setCurrentFarm(res.farm_id); setTab("dashboard"); toast("Logged in");
      loadFarms();
    } catch (e) { toast(String(e)); }
  }

  async function loadFarms() {
    try {
      const res = await api.farms() as { farms: Array<{ farm_id: string; name: string }> };
      setFarms(res.farms); if (!currentFarm && res.farms[0]) { setCurrentFarm(res.farms[0].farm_id); setFarmId(res.farms[0].farm_id); }
    } catch (e) { console.error(e); }
  }

  async function loadDashboard() {
    if (!currentFarm) return;
    try {
      const [w, pw, cf, cr, sms, mon, hard, au, ra] = await Promise.all([
        api.workers(currentFarm) as Promise<{ workers: unknown[] }>,
        api.payrollWeeks(currentFarm) as Promise<{ weeks: unknown[] }>,
        api.conflicts(currentFarm) as Promise<{ conflicts: unknown[] }>,
        api.corrections(currentFarm) as Promise<{ corrections: unknown[] }>,
        api.smsLog(currentFarm) as Promise<{ messages: unknown[] }>,
        api.monthly(currentFarm) as Promise<{ monthly: unknown[] }>,
        api.hardest(currentFarm, quarter) as Promise<{ ranking: unknown[] }>,
        api.auditLog(currentFarm) as Promise<{ logs: unknown[] }>,
        api.rates(currentFarm) as Promise<{ rates: unknown[] }>,
      ]);
      setWorkers(w.workers ?? []); setPayrollWeeks(pw.weeks ?? []); setConflicts(cf.conflicts ?? []); setCorrections(cr.corrections ?? []); setSmsLog(sms.messages ?? []); setMonthly(mon.monthly ?? []); setHardest(hard.ranking ?? []); setAudit(au.logs ?? []); setRates(ra.rates ?? []);
    } catch (e) { toast(String(e)); }
  }

  useEffect(() => { if (currentFarm) loadDashboard(); }, [currentFarm, tab, quarter]);
  useEffect(() => { loadFarms(); }, []);

  async function loadPayroll() {
    if (!currentFarm) return;
    try {
      const res = await api.payroll(currentFarm, weekStart) as { sheet: never };
      setPayrollSheet(res as never);
    } catch (e) { toast(String(e)); }
  }

  async function doCsvPreview() {
    try { const res = await api.csvPreview(currentFarm, csvText); setCsvPreview(res); } catch (e) { toast(String(e)); }
  }
  async function doCsvCommit() {
    try { const res = await api.csvCommit(currentFarm, csvText) as { imported: number }; toast(`Imported ${res.imported} rows`); setCsvPreview(null); } catch (e) { toast(String(e)); }
  }

  function logout() { clearToken(); setTab("login"); toast("Logged out"); }

  if (tab === "login") {
    return <div style={{ maxWidth: 400, margin: "60px auto", background: "#FFFDF6", padding: 24, borderRadius: 12, border: "1px solid #D9D2BC" }}>
      <h2 style={{ margin: 0 }}>Admin Login</h2><p style={{ color: "#4A4A42", fontSize: 13 }}>Password from ADMIN_DEFAULT_PASSWORD (default tea-admin-2026 in dev). Session 7d. No MFA (deferred per Decision 22).</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
        <input placeholder="username" value={username} onChange={e => setUsername(e.target.value)} />
        <input placeholder="password" type="password" value={password} onChange={e => setPassword(e.target.value)} />
        <button className="primary" onClick={doLogin}>Login</button>
      </div>
      {msg && <div style={{ marginTop: 10, color: "#C62828", fontSize: 13 }}>{msg}</div>}
      <p style={{ fontSize: 11, color: "#6B6B5E", marginTop: 12 }}>Demo: use admin / tea-admin-2026 (or env ADMIN_DEFAULT_PASSWORD). All audit-logged.</p>
    </div>;
  }

  return <div>
    <header>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1>Tea Ledger Admin</h1>
        <select value={currentFarm} onChange={e => { setCurrentFarm(e.target.value); setFarmId(e.target.value); }} style={{ padding: "6px 10px", borderRadius: 8, border: 0 }}>
          {farms.map(f => <option key={f.farm_id} value={f.farm_id}>{f.name} ({f.farm_id.slice(0, 8)})</option>)}
          {farms.length === 0 && <option>No farms</option>}
        </select>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 12, opacity: 0.8 }}>{currentFarm ? `Farm ${currentFarm.slice(0, 8)}` : ""}</span>
        <button onClick={logout} style={{ background: "#FFFDF6", color: "#1F4D2B", border: 0, padding: "6px 10px", borderRadius: 8, cursor: "pointer" }}>Logout</button>
      </div>
    </header>
    <nav style={{ padding: "12px 16px", background: "#EEF3EE", borderBottom: "1px solid #D9D2BC", display: "flex", gap: 8, flexWrap: "wrap" }}>
      {(["dashboard", "workers", "payroll", "conflicts", "sms", "reports", "import", "settings", "audit"] as Tab[]).map(t => (
        <button key={t} onClick={() => setTab(t)} className={tab === t ? "active" : ""} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #2D6A3E", background: tab === t ? "#1F4D2B" : "white", color: tab === t ? "white" : "#1F4D2B", fontWeight: 600, cursor: "pointer" }}>{t}</button>
      ))}
    </nav>
    {msg && <div style={{ margin: "10px 16px", padding: "8px 12px", background: "#FFF3E0", border: "1px solid #FFCC80", borderRadius: 8, fontSize: 13 }}>{msg}</div>}

    {tab === "dashboard" && <div className="card">
      <h3 style={{ marginTop: 0 }}>Dashboard — {farms.find(f => f.farm_id === currentFarm)?.name ?? "Farm"}</h3>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ background: "#F2F5EA", padding: 12, borderRadius: 8, minWidth: 140 }}><div style={{ fontSize: 22, fontWeight: 800 }}>{workers.length}</div><div style={{ fontSize: 12, color: "#3F3F38" }}>Workers</div></div>
        <div style={{ background: "#F2F5EA", padding: 12, borderRadius: 8, minWidth: 140 }}><div style={{ fontSize: 22, fontWeight: 800 }}>{payrollWeeks.length}</div><div style={{ fontSize: 12, color: "#3F3F38" }}>Pay Weeks</div></div>
        <div style={{ background: conflicts.length ? "#FDEDEC" : "#F2F5EA", padding: 12, borderRadius: 8, minWidth: 140 }}><div style={{ fontSize: 22, fontWeight: 800 }}>{conflicts.length}</div><div style={{ fontSize: 12, color: "#3F3F38" }}>Unresolved conflicts</div></div>
        <div style={{ background: corrections.length ? "#FFF3E0" : "#F2F5EA", padding: 12, borderRadius: 8, minWidth: 140 }}><div style={{ fontSize: 22, fontWeight: 800 }}>{corrections.length}</div><div style={{ fontSize: 12, color: "#3F3F38" }}>Correction requests</div></div>
      </div>
      <h4>Pay Weeks</h4>
      <table><thead><tr><th>Week</th><th>Status</th><th>Locked At</th></tr></thead><tbody>
        {(payrollWeeks as Array<{ week_start: string; week_end: string; status: string; locked_at: string | null }>).map(w => (
          <tr key={w.week_start}><td>{w.week_start} → {w.week_end}</td><td><span className={`badge ${w.status === "locked" ? "locked" : "open"}`}>{w.status}</span></td><td>{w.locked_at ? new Date(w.locked_at).toLocaleString() : "-"}</td></tr>
        ))}
        {payrollWeeks.length === 0 && <tr><td colSpan={3} style={{ textAlign: "center", color: "#6B6B5E" }}>No weeks yet</td></tr>}
      </tbody></table>
      <p style={{ fontSize: 12, color: "#4A4A42" }}>Data: farm_id on all tables, append-only events, server authoritative lock. Kg does not reflect leaf quality — ranking only (see Reports).</p>
    </div>}

    {tab === "workers" && <div className="card">
      <h3>Workers — full employment history</h3>
      <table><thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Verified</th></tr></thead><tbody>
        {(workers as Array<{ worker_id: string; full_name: string; phone_e164: string | null; status: string; verified: boolean }>).map(w => (
          <tr key={w.worker_id}><td>{w.full_name}</td><td>{w.phone_e164 ?? "-"}</td><td>{w.status}</td><td>{w.verified ? "✓" : "—"}</td></tr>
        ))}
      </tbody></table>
      <p style={{ fontSize: 12, color: "#4A4A42" }}>Hire/fire/rehire on same profile per employment_periods inclusive dates. Phone reuse after inactive with re-verification (Decision 17,19).</p>
      <button className="secondary" onClick={loadDashboard}>Refresh</button>
    </div>}

    {tab === "payroll" && <div className="card">
      <h3>Payroll Sheets — with flags</h3>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label>Week start (Mon): <input type="date" value={weekStart} onChange={e => setWeekStart(e.target.value)} /></label>
        <button className="primary" onClick={loadPayroll}>Load Sheet</button>
        {payrollSheet && <a href={`/api/farms/${currentFarm}/payroll/${weekStart}?format=csv`} download style={{ fontSize: 13 }}>Download CSV</a>}
        {payrollSheet && <a href={`/api/farms/${currentFarm}/payroll/${weekStart}?format=html`} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>Printable HTML</a>}
      </div>
      {payrollSheet ? <div style={{ marginTop: 12 }}>
        <div><span className={`badge ${payrollSheet.sheet.status === "locked" ? "locked" : "open"}`}>{payrollSheet.sheet.status}</span> {payrollSheet.sheet.weekStart} → {payrollSheet.sheet.weekEnd}</div>
        <table><thead><tr><th>Worker</th><th>Phone</th><th>Days</th><th>Kg</th><th>Amount KES</th><th>Flags</th></tr></thead><tbody>
          {payrollSheet.sheet.lines.map((l: { name: string; maskedPhone: string; daysWorked: number; totalKg: number; amountKes: number; flags: string[] }) => (
            <tr key={l.name}><td>{l.name}</td><td>{l.maskedPhone}</td><td>{l.daysWorked}</td><td>{l.totalKg.toFixed(1)}</td><td><strong>{l.amountKes}</strong></td><td>{l.flags.map((f: string) => <span key={f} className="flag" style={{ marginRight: 4 }}>{f}</span>)}</td></tr>
          ))}
        </tbody><tfoot><tr><td colSpan={3}><strong>Totals</strong></td><td><strong>{payrollSheet.sheet.totals.totalKg.toFixed(1)}</strong></td><td><strong>KES {payrollSheet.sheet.totals.totalAmountKes}</strong></td><td></td></tr></tfoot></table>
      </div> : <p style={{ color: "#6B6B5E" }}>Pick a Monday and load. Grand total is sum of rounded worker amounts. Anomaly flags computed from trailing 4 weeks.</p>}
      <h4 style={{ marginTop: 16 }}>Next-week Adjustment (post-lock correction)</h4>
      <p style={{ fontSize: 12, color: "#4A4A42" }}>Locked week corrections never edit history; Admin creates adjustment applied to next week. Owner notified by SMS.</p>
      <AdjustmentForm farmId={currentFarm} onDone={() => toast("Adjustment created → next week")} />
    </div>}

    {tab === "conflicts" && <div className="card">
      <h3>Unresolved Same-Worker/Same-Day Conflicts</h3>
      <p style={{ fontSize: 12, color: "#4A4A42" }}>Never silent last-write-wins (Decision 20). Resolution is a new event. Phase 1 normally one device.</p>
      <table><thead><tr><th>Date</th><th>Event</th><th>Conflict</th></tr></thead><tbody>
        {(conflicts as Array<{ business_date: string; event_type: string; conflict_flag: boolean; payload: { worker_id: string } }>).map((c, i) => (
          <tr key={i}><td>{c.business_date.slice(0, 10)}</td><td>{c.event_type}</td><td>{c.conflict_flag ? "⚠️ unresolved" : ""} {c.payload?.worker_id?.slice(0, 8)}</td></tr>
        ))}
        {conflicts.length === 0 && <tr><td colSpan={3} style={{ textAlign: "center", color: "#6B6B5E" }}>No conflicts</td></tr>}
      </tbody></table>
      <h4>Correction Requests (late events for locked week)</h4>
      <table><thead><tr><th>Date</th><th>Payload</th><th>Flag</th></tr></thead><tbody>
        {(corrections as Array<{ business_date: string; payload: unknown; correction_flag: boolean }>).map((c, i) => (
          <tr key={i}><td>{c.business_date.slice(0, 10)}</td><td style={{ fontSize: 11, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }}>{JSON.stringify(c.payload).slice(0, 120)}</td><td>{c.correction_flag ? "correction" : ""}</td></tr>
        ))}
        {corrections.length === 0 && <tr><td colSpan={3} style={{ textAlign: "center", color: "#6B6B5E" }}>No corrections</td></tr>}
      </tbody></table>
    </div>}

    {tab === "sms" && <div className="card">
      <h3>SMS Log — delivery status & costs</h3>
      <table><thead><tr><th>Type</th><th>To</th><th>Body</th><th>Segs</th><th>Status</th></tr></thead><tbody>
        {(smsLog as Array<{ type: string; to_phone: string; body: string; segments: number; status: string }>).map((m, i) => (
          <tr key={i}><td>{m.type}</td><td>{m.to_phone}</td><td style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", fontSize: 12 }}>{m.body.slice(0, 80)}</td><td>{m.segments}</td><td>{m.status}</td></tr>
        ))}
        {smsLog.length === 0 && <tr><td colSpan={5} style={{ textAlign: "center", color: "#6B6B5E" }}>No SMS</td></tr>}
      </tbody></table>
      <p style={{ fontSize: 12, color: "#4A4A42" }}>Segments & cost_estimate_cents logged per farm per month. GSM-7 only (no emojis). Provider mock in preview, AT sandbox/live via env.</p>
    </div>}

    {tab === "reports" && <div className="card">
      <h3>Reports — quarterly & monthly</h3>
      {(() => {
        const rows = monthly as Array<{ month: string; total_kg: number; payroll_kes: number; active_workers: number }>;
        const bestMonth = rows.length ? rows.reduce((a, b) => (b.total_kg > a.total_kg ? b : a)) : null;
        const last3 = rows.slice(-3);
        const kg3 = last3.reduce((s, m) => s + (Number(m.total_kg) || 0), 0);
        const pay3 = last3.reduce((s, m) => s + (Number(m.payroll_kes) || 0), 0);
        const top = (hardest as Array<{ name: string; total_kg: number; avg_kg_per_day: number; attendance_rate: number | null; days_attended: number; attendance_denom: number }>)[0];
        return (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, margin: "10px 0 16px" }}>
              <StatCard label="Best month" value={bestMonth ? String(bestMonth.month) : "—"} sub={bestMonth ? `${Number(bestMonth.total_kg).toLocaleString()} kg picked` : "no data yet"} />
              <StatCard label="Hardest worker" value={top ? top.name : "—"} sub={top ? `${Number(top.total_kg).toLocaleString()} kg · ${Number(top.avg_kg_per_day).toFixed(1)} kg/day` : `no data for ${quarter}`} />
              <StatCard label="Last 3 months" value={`${kg3.toLocaleString()} kg`} sub={`KES ${pay3.toLocaleString()} payroll`} />
              <StatCard label="Months recorded" value={String(rows.length)} sub={`${rows.reduce((s, m) => s + (Number(m.active_workers) || 0), 0) ? "worker-months of activity" : "and counting"}`} />
            </div>
            <h4>Total kg by month</h4>
            <BarChart data={rows.map(m => ({ label: String(m.month), value: Number(m.total_kg) || 0 }))} color="#2D6A3E" />
            <h4>Payroll by month (KES)</h4>
            <BarChart data={rows.map(m => ({ label: String(m.month), value: Number(m.payroll_kes) || 0 }))} color="#E3A72F" />
            <h4 style={{ marginTop: 18 }}>Monthly detail</h4>
            <table><thead><tr><th>Month</th><th>Total kg</th><th>Payroll KES</th><th>Workers</th></tr></thead><tbody>
              {rows.map(m => (
                <tr key={m.month}><td>{m.month}</td><td>{Number(m.total_kg).toLocaleString()}</td><td>{Number(m.payroll_kes).toLocaleString()}</td><td>{m.active_workers}</td></tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={4} style={{ textAlign: "center", color: "#6B6B5E" }}>No data yet</td></tr>}
            </tbody></table>
            <h4 style={{ marginTop: 18 }}>
              Hardest-working ranking —{" "}
              <select value={quarter} onChange={e => setQuarter(e.target.value)} style={{ fontSize: 14, padding: "4px 8px", borderRadius: 8, border: "1px solid #D9D2BC", background: "#FFFDF6", color: "#23231F" }}>
                {lastQuarters(8).map(q => <option key={q} value={q}>{q}</option>)}
              </select>
            </h4>
            <p style={{ fontSize: 12, color: "#4A4A42" }}>Three measures side by side: total kg, avg kg per attended plucking day, attendance rate (plucking days during active employment). Kg does not reflect leaf quality — ranking only.</p>
            <table><thead><tr><th>Rank</th><th>Worker</th><th>Total kg</th><th>Avg kg/day</th><th>Attendance</th></tr></thead><tbody>
              {(hardest as Array<{ name: string; total_kg: number; avg_kg_per_day: number; attendance_rate: number | null; days_attended: number; attendance_denom: number }>).map((h, i) => (
                <tr key={h.name}><td>#{i + 1}</td><td>{h.name}</td><td>{Number(h.total_kg).toLocaleString()}</td><td>{Number(h.avg_kg_per_day).toFixed(1)}</td><td>{h.attendance_rate !== null ? `${(h.attendance_rate * 100).toFixed(1)}% (${h.days_attended}/${h.attendance_denom})` : "-"}</td></tr>
              ))}
              {hardest.length === 0 && <tr><td colSpan={5} style={{ textAlign: "center", color: "#6B6B5E" }}>No data for quarter</td></tr>}
            </tbody></table>
          </>
        );
      })()}
    </div>}

    {tab === "import" && <div className="card">
      <h3>CSV Import — historical records</h3>
      <p style={{ fontSize: 12, color: "#4A4A42" }}>Canonical template: worker_id,full_name,phone_e164,business_date,kg_units,present,is_plucking_day. Preview before commit; duplicates rejected for explicit resolution.</p>
      <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={10} style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} />
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="secondary" onClick={doCsvPreview}>Preview</button>
        <button className="primary" onClick={doCsvCommit}>Commit</button>
        <a href={`/api/farms/${currentFarm}/csv-template`} style={{ fontSize: 13, alignSelf: "center" }}>Download template</a>
      </div>
      {csvPreview ? <pre style={{ background: "#F5F1E3", padding: 12, borderRadius: 8, fontSize: 12, overflow: "auto" }}>{JSON.stringify(csvPreview, null, 2)}</pre> : null}
    </div>}

    {tab === "settings" && <div className="card">
      <h3>Farm Settings</h3>
      <p style={{ fontSize: 12, color: "#4A4A42" }}>Rate with effective dates, thresholds, SMS language, Owner/supervisor numbers, cutoff times per farm_id.</p>
      <table><thead><tr><th>Effective From</th><th>Rate KES/kg</th></tr></thead><tbody>
        {(rates as Array<{ effective_from: string; rate_cents_per_kg: number }>).map(r => (
          <tr key={r.effective_from}><td>{r.effective_from}</td><td>{(r.rate_cents_per_kg / 100).toFixed(2)}</td></tr>
        ))}
      </tbody></table>
      <RateForm farmId={currentFarm} onDone={loadDashboard} />
    </div>}

    {tab === "audit" && <div className="card">
      <h3>Audit Log — every change with author & time</h3>
      <table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>
        {(audit as Array<{ created_at: string; actor: string; action: string; target: string | null }>).map((a, i) => (
          <tr key={i}><td style={{ fontSize: 11 }}>{new Date(a.created_at).toLocaleString()}</td><td>{a.actor}</td><td>{a.action}</td><td>{a.target ?? "-"}</td></tr>
        ))}
        {audit.length === 0 && <tr><td colSpan={4} style={{ textAlign: "center", color: "#6B6B5E" }}>No audit entries</td></tr>}
      </tbody></table>
    </div>}
  </div>;
}

function AdjustmentForm({ farmId, onDone }: { farmId: string; onDone: () => void }) {
  const [workerId, setWorkerId] = useState("");
  const [correctionWeek, setCorrectionWeek] = useState("2026-11-23");
  const [kg, setKg] = useState("5");
  const [reason, setReason] = useState("late correction");
  const [msg, setMsg] = useState("");
  async function submit() {
    try {
      await api.createAdjustment(farmId, { worker_id: workerId, correction_week_start: correctionWeek, kg: Number(kg), reason });
      setMsg("Created"); onDone();
    } catch (e) { setMsg(String(e)); }
  }
  return <div style={{ background: "#FFF9F0", border: "1px solid #FFE0B2", borderRadius: 8, padding: 12, marginTop: 8 }}>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <input placeholder="worker_id" value={workerId} onChange={e => setWorkerId(e.target.value)} style={{ flex: "1 1 180px" }} />
      <input type="date" value={correctionWeek} onChange={e => setCorrectionWeek(e.target.value)} />
      <input placeholder="kg" value={kg} onChange={e => setKg(e.target.value)} style={{ width: 80 }} />
    </div>
    <input placeholder="reason" value={reason} onChange={e => setReason(e.target.value)} style={{ width: "100%", marginTop: 8 }} />
    <button className="primary" onClick={submit} style={{ marginTop: 8 }}>Create Adjustment (next week)</button>
    {msg && <span style={{ marginLeft: 8, fontSize: 12 }}>{msg}</span>}
  </div>;
}

function RateForm({ farmId, onDone }: { farmId: string; onDone: () => void }) {
  const [effectiveFrom, setEffectiveFrom] = useState("2026-12-01");
  const [rate, setRate] = useState("10");
  const [msg, setMsg] = useState("");
  async function submit() {
    try { await api.setRate(farmId, effectiveFrom, Math.round(Number(rate) * 100)); setMsg("Saved"); onDone(); } catch (e) { setMsg(String(e)); }
  }
  return <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
    <input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} />
    <input value={rate} onChange={e => setRate(e.target.value)} placeholder="KES/kg" style={{ width: 80 }} />
    <button className="primary" onClick={submit}>Set Rate</button>
    {msg && <span style={{ fontSize: 12 }}>{msg}</span>}
  </div>;
}
