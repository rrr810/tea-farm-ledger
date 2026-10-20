import { useEffect, useState } from "react";
import { api, token, setToken, clearToken, farmId, setFarmId } from "./api.js";

type Tab = "login" | "dashboard" | "workers" | "payroll" | "conflicts" | "sms" | "reports" | "import" | "settings" | "audit";

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
        api.hardest(currentFarm, "2026-Q4") as Promise<{ ranking: unknown[] }>,
        api.auditLog(currentFarm) as Promise<{ logs: unknown[] }>,
        api.rates(currentFarm) as Promise<{ rates: unknown[] }>,
      ]);
      setWorkers(w.workers ?? []); setPayrollWeeks(pw.weeks ?? []); setConflicts(cf.conflicts ?? []); setCorrections(cr.corrections ?? []); setSmsLog(sms.messages ?? []); setMonthly(mon.monthly ?? []); setHardest(hard.ranking ?? []); setAudit(au.logs ?? []); setRates(ra.rates ?? []);
    } catch (e) { toast(String(e)); }
  }

  useEffect(() => { if (currentFarm) loadDashboard(); }, [currentFarm, tab]);
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
    return <div style={{ maxWidth: 400, margin: "60px auto", background: "white", padding: 24, borderRadius: 12, border: "1px solid #DDD" }}>
      <h2 style={{ margin: 0 }}>Admin Login</h2><p style={{ color: "#666", fontSize: 13 }}>Password from ADMIN_DEFAULT_PASSWORD (default tea-admin-2026 in dev). Session 7d. No MFA (deferred per Decision 22).</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
        <input placeholder="username" value={username} onChange={e => setUsername(e.target.value)} />
        <input placeholder="password" type="password" value={password} onChange={e => setPassword(e.target.value)} />
        <button className="primary" onClick={doLogin}>Login</button>
      </div>
      {msg && <div style={{ marginTop: 10, color: "#C62828", fontSize: 13 }}>{msg}</div>}
      <p style={{ fontSize: 11, color: "#888", marginTop: 12 }}>Demo: use admin / tea-admin-2026 (or env ADMIN_DEFAULT_PASSWORD). All audit-logged.</p>
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
        <button onClick={logout} style={{ background: "white", color: "#1B4332", border: 0, padding: "6px 10px", borderRadius: 8, cursor: "pointer" }}>Logout</button>
      </div>
    </header>
    <nav style={{ padding: "12px 16px", background: "#EEF3EE", borderBottom: "1px solid #DDE3DD", display: "flex", gap: 8, flexWrap: "wrap" }}>
      {(["dashboard", "workers", "payroll", "conflicts", "sms", "reports", "import", "settings", "audit"] as Tab[]).map(t => (
        <button key={t} onClick={() => setTab(t)} className={tab === t ? "active" : ""} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #2D6A4F", background: tab === t ? "#1B4332" : "white", color: tab === t ? "white" : "#1B4332", fontWeight: 600, cursor: "pointer" }}>{t}</button>
      ))}
    </nav>
    {msg && <div style={{ margin: "10px 16px", padding: "8px 12px", background: "#FFF3E0", border: "1px solid #FFCC80", borderRadius: 8, fontSize: 13 }}>{msg}</div>}

    {tab === "dashboard" && <div className="card">
      <h3 style={{ marginTop: 0 }}>Dashboard — {farms.find(f => f.farm_id === currentFarm)?.name ?? "Farm"}</h3>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ background: "#F1F8F1", padding: 12, borderRadius: 8, minWidth: 140 }}><div style={{ fontSize: 22, fontWeight: 800 }}>{workers.length}</div><div style={{ fontSize: 12, color: "#555" }}>Workers</div></div>
        <div style={{ background: "#F1F8F1", padding: 12, borderRadius: 8, minWidth: 140 }}><div style={{ fontSize: 22, fontWeight: 800 }}>{payrollWeeks.length}</div><div style={{ fontSize: 12, color: "#555" }}>Pay Weeks</div></div>
        <div style={{ background: conflicts.length ? "#FDEDEC" : "#F1F8F1", padding: 12, borderRadius: 8, minWidth: 140 }}><div style={{ fontSize: 22, fontWeight: 800 }}>{conflicts.length}</div><div style={{ fontSize: 12, color: "#555" }}>Unresolved conflicts</div></div>
        <div style={{ background: corrections.length ? "#FFF3E0" : "#F1F8F1", padding: 12, borderRadius: 8, minWidth: 140 }}><div style={{ fontSize: 22, fontWeight: 800 }}>{corrections.length}</div><div style={{ fontSize: 12, color: "#555" }}>Correction requests</div></div>
      </div>
      <h4>Pay Weeks</h4>
      <table><thead><tr><th>Week</th><th>Status</th><th>Locked At</th></tr></thead><tbody>
        {(payrollWeeks as Array<{ week_start: string; week_end: string; status: string; locked_at: string | null }>).map(w => (
          <tr key={w.week_start}><td>{w.week_start} → {w.week_end}</td><td><span className={`badge ${w.status === "locked" ? "locked" : "open"}`}>{w.status}</span></td><td>{w.locked_at ? new Date(w.locked_at).toLocaleString() : "-"}</td></tr>
        ))}
        {payrollWeeks.length === 0 && <tr><td colSpan={3} style={{ textAlign: "center", color: "#888" }}>No weeks yet</td></tr>}
      </tbody></table>
      <p style={{ fontSize: 12, color: "#666" }}>Data: farm_id on all tables, append-only events, server authoritative lock. Kg does not reflect leaf quality — ranking only (see Reports).</p>
    </div>}

    {tab === "workers" && <div className="card">
      <h3>Workers — full employment history</h3>
      <table><thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Verified</th></tr></thead><tbody>
        {(workers as Array<{ worker_id: string; full_name: string; phone_e164: string | null; status: string; verified: boolean }>).map(w => (
          <tr key={w.worker_id}><td>{w.full_name}</td><td>{w.phone_e164 ?? "-"}</td><td>{w.status}</td><td>{w.verified ? "✓" : "—"}</td></tr>
        ))}
      </tbody></table>
      <p style={{ fontSize: 12, color: "#666" }}>Hire/fire/rehire on same profile per employment_periods inclusive dates. Phone reuse after inactive with re-verification (Decision 17,19).</p>
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
      </div> : <p style={{ color: "#888" }}>Pick a Monday and load. Grand total is sum of rounded worker amounts. Anomaly flags computed from trailing 4 weeks.</p>}
      <h4 style={{ marginTop: 16 }}>Next-week Adjustment (post-lock correction)</h4>
      <p style={{ fontSize: 12, color: "#666" }}>Locked week corrections never edit history; Admin creates adjustment applied to next week. Owner notified by SMS.</p>
      <AdjustmentForm farmId={currentFarm} onDone={() => toast("Adjustment created → next week")} />
    </div>}

    {tab === "conflicts" && <div className="card">
      <h3>Unresolved Same-Worker/Same-Day Conflicts</h3>
      <p style={{ fontSize: 12, color: "#666" }}>Never silent last-write-wins (Decision 20). Resolution is a new event. Phase 1 normally one device.</p>
      <table><thead><tr><th>Date</th><th>Event</th><th>Conflict</th></tr></thead><tbody>
        {(conflicts as Array<{ business_date: string; event_type: string; conflict_flag: boolean; payload: { worker_id: string } }>).map((c, i) => (
          <tr key={i}><td>{c.business_date.slice(0, 10)}</td><td>{c.event_type}</td><td>{c.conflict_flag ? "⚠️ unresolved" : ""} {c.payload?.worker_id?.slice(0, 8)}</td></tr>
        ))}
        {conflicts.length === 0 && <tr><td colSpan={3} style={{ textAlign: "center", color: "#888" }}>No conflicts</td></tr>}
      </tbody></table>
      <h4>Correction Requests (late events for locked week)</h4>
      <table><thead><tr><th>Date</th><th>Payload</th><th>Flag</th></tr></thead><tbody>
        {(corrections as Array<{ business_date: string; payload: unknown; correction_flag: boolean }>).map((c, i) => (
          <tr key={i}><td>{c.business_date.slice(0, 10)}</td><td style={{ fontSize: 11, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }}>{JSON.stringify(c.payload).slice(0, 120)}</td><td>{c.correction_flag ? "correction" : ""}</td></tr>
        ))}
        {corrections.length === 0 && <tr><td colSpan={3} style={{ textAlign: "center", color: "#888" }}>No corrections</td></tr>}
      </tbody></table>
    </div>}

    {tab === "sms" && <div className="card">
      <h3>SMS Log — delivery status & costs</h3>
      <table><thead><tr><th>Type</th><th>To</th><th>Body</th><th>Segs</th><th>Status</th></tr></thead><tbody>
        {(smsLog as Array<{ type: string; to_phone: string; body: string; segments: number; status: string }>).map((m, i) => (
          <tr key={i}><td>{m.type}</td><td>{m.to_phone}</td><td style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", fontSize: 12 }}>{m.body.slice(0, 80)}</td><td>{m.segments}</td><td>{m.status}</td></tr>
        ))}
        {smsLog.length === 0 && <tr><td colSpan={5} style={{ textAlign: "center", color: "#888" }}>No SMS</td></tr>}
      </tbody></table>
      <p style={{ fontSize: 12, color: "#666" }}>Segments & cost_estimate_cents logged per farm per month. GSM-7 only (no emojis). Provider mock in preview, AT sandbox/live via env.</p>
    </div>}

    {tab === "reports" && <div className="card">
      <h3>Reports — monthly, rolling 3-month, quarterly ranking</h3>
      <h4>Monthly kg & payroll</h4>
      <table><thead><tr><th>Month</th><th>Total kg</th><th>Payroll KES</th><th>Workers</th></tr></thead><tbody>
        {(monthly as Array<{ month: string; total_kg: number; payroll_kes: number; active_workers: number }>).map(m => (
          <tr key={m.month}><td>{m.month}</td><td>{m.total_kg}</td><td>{m.payroll_kes}</td><td>{m.active_workers}</td></tr>
        ))}
      </tbody></table>
      <h4>Hardest-working Ranking (Quarter 2026-Q4) — 3 measures</h4>
      <p style={{ fontSize: 12, color: "#666" }}>Total kg, avg kg per attended plucking day, attendance rate (plucking days during active employment). kg does not reflect leaf quality — rankings only.</p>
      <table><thead><tr><th>Rank</th><th>Worker</th><th>Total kg</th><th>Avg kg/day</th><th>Attendance</th></tr></thead><tbody>
        {(hardest as Array<{ name: string; total_kg: number; avg_kg_per_day: number; attendance_rate: number | null; days_attended: number; attendance_denom: number }>).map((h, i) => (
          <tr key={h.name}><td>#{i + 1}</td><td>{h.name}</td><td>{h.total_kg}</td><td>{h.avg_kg_per_day}</td><td>{h.attendance_rate !== null ? `${(h.attendance_rate * 100).toFixed(1)}% (${h.days_attended}/${h.attendance_denom})` : "-"}</td></tr>
        ))}
        {hardest.length === 0 && <tr><td colSpan={5} style={{ textAlign: "center", color: "#888" }}>No data for quarter</td></tr>}
      </tbody></table>
    </div>}

    {tab === "import" && <div className="card">
      <h3>CSV Import — historical records</h3>
      <p style={{ fontSize: 12, color: "#666" }}>Canonical template: worker_id,full_name,phone_e164,business_date,kg_units,present,is_plucking_day. Preview before commit; duplicates rejected for explicit resolution.</p>
      <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={10} style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} />
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="secondary" onClick={doCsvPreview}>Preview</button>
        <button className="primary" onClick={doCsvCommit}>Commit</button>
        <a href={`/api/farms/${currentFarm}/csv-template`} style={{ fontSize: 13, alignSelf: "center" }}>Download template</a>
      </div>
      {csvPreview ? <pre style={{ background: "#F5F5F0", padding: 12, borderRadius: 8, fontSize: 12, overflow: "auto" }}>{JSON.stringify(csvPreview, null, 2)}</pre> : null}
    </div>}

    {tab === "settings" && <div className="card">
      <h3>Farm Settings</h3>
      <p style={{ fontSize: 12, color: "#666" }}>Rate with effective dates, thresholds, SMS language, Owner/supervisor numbers, cutoff times per farm_id.</p>
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
        {audit.length === 0 && <tr><td colSpan={4} style={{ textAlign: "center", color: "#888" }}>No audit entries</td></tr>}
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
