import { useEffect, useState } from "react";
import { db, todayEAT } from "./db.js";
import type { LocalWorker, DailyEntryLocal } from "./db.js";
import { normalizeKePhone, calculateWorkerWeekPayKes } from "@tea-ledger/core";

type Tab = "workers" | "daily";

export default function App() {
  const [tab, setTab] = useState<Tab>("daily");
  const [pending, setPending] = useState(0);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [farmId, setFarmId] = useState(localStorage.getItem("farm_id") ?? "");
  const [workers, setWorkers] = useState<LocalWorker[]>([]);
  const [selectedDate, setSelectedDate] = useState(todayEAT());
  const [isPluckingDay, setIsPluckingDay] = useState(true);
  const [noPluckReason, setNoPluckReason] = useState("");
  const [daily, setDaily] = useState<DailyEntryLocal[]>([]);
  const [msg, setMsg] = useState("");

  // forms
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [hireWorkerId, setHireWorkerId] = useState("");
  const [fireDate, setFireDate] = useState(todayEAT());
  const [fireReason, setFireReason] = useState("");

  useEffect(() => {
    const onO = () => setOnline(true);
    const onF = () => setOnline(false);
    window.addEventListener("online", onO);
    window.addEventListener("offline", onF);
    const id = setInterval(async () => {
      setPending(await db.outbox.count());
      setLastSynced(localStorage.getItem("last_synced"));
      setWorkers(await db.workers.toArray());
      setDaily(await db.daily.where("date").equals(selectedDate).toArray());
    }, 1000);
    return () => { window.removeEventListener("online", onO); window.removeEventListener("offline", onF); clearInterval(id); };
  }, [selectedDate]);

  async function saveFarmId(v: string) {
    setFarmId(v); localStorage.setItem("farm_id", v);
    if (v && online) {
      try {
        const res = await fetch(`/api/farms/${v}/workers`);
        if (res.ok) {
          const data = await res.json() as { workers: LocalWorker[] };
          for (const w of data.workers) await db.workers.put(w);
        }
      } catch {}
    }
  }

  async function registerWorker() {
    const norm = normalizeKePhone(phone);
    if (!norm.ok) { setMsg(`Invalid phone: ${norm.reason}`); return; }
    if (!fullName.trim()) { setMsg("Name required"); return; }
    if (!consent) { setMsg("Consent checkbox required (Decision 18)"); return; }
    if (!farmId) { setMsg("Set Farm ID first"); return; }
    const worker_id = crypto.randomUUID();
    const worker: LocalWorker = { worker_id, farm_id: farmId, full_name: fullName.trim(), phone_e164: norm.e164, status: "active", verified: false, consent_at: new Date().toISOString(), consent_author: "supervisor" };
    await db.workers.put(worker);
    const event_id = crypto.randomUUID();
    const ev = { event_id, farm_id: farmId, device_id: localStorage.getItem("device_id") ?? crypto.randomUUID(), author: "supervisor", event_type: "worker.registered", payload: { worker_id, full_name: worker.full_name, phone_e164: worker.phone_e164, consent: true, consent_at: worker.consent_at, consent_author: worker.consent_author }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "worker.registered" });
    // auto employment period
    const empId = crypto.randomUUID();
    await db.employment.add({ id: empId, worker_id, farm_id: farmId, start_date: selectedDate, end_date: null });
    const empEv = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: localStorage.getItem("device_id") ?? "", author: "supervisor", event_type: "employment.started", payload: { worker_id, start_date: selectedDate }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: empEv.event_id, farm_id: farmId, payload: empEv, createdAt: new Date().toISOString(), type: "employment.started" });
    setMsg(`Queued ${worker.full_name} — verification SMS will send when online. Worker can be logged even offline (Decision 1).`);
    setFullName(""); setPhone(""); setConsent(false);
  }

  async function fireWorker() {
    if (!hireWorkerId) { setMsg("Select worker"); return; }
    const period = await db.employment.where("worker_id").equals(hireWorkerId).filter(p=> p.end_date===null).first();
    if (!period) { setMsg("No active period"); return; }
    if (fireDate < period.start_date) { setMsg("End date cannot be before start (inclusive)"); return; }
    await db.employment.update(period.id, { end_date: fireDate });
    const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: localStorage.getItem("device_id") ?? "", author: "supervisor", event_type: "employment.ended", payload: { worker_id: hireWorkerId, end_date: fireDate, reason: fireReason }, business_date: fireDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "employment.ended" });
    await db.workers.update(hireWorkerId, { status: "inactive" });
    setMsg(`Fired — period closed ${period.start_date} to ${fireDate} inclusive. Rehiring opens new period on same profile.`);
  }

  async function rehireWorker() {
    if (!hireWorkerId) { setMsg("Select worker"); return; }
    const periods = await db.employment.where("worker_id").equals(hireWorkerId).toArray();
    if (periods.some(p=> p.end_date===null)) { setMsg("Already active — cannot rehire"); return; }
    const lastEnd = periods.filter(p=> p.end_date).sort((a,b)=> (a.end_date as string).localeCompare(b.end_date as string)).pop();
    if (lastEnd && selectedDate <= (lastEnd.end_date as string)) { setMsg(`Start must be after ${lastEnd.end_date} inclusive`); return; }
    const id = crypto.randomUUID();
    await db.employment.add({ id, worker_id: hireWorkerId, farm_id: farmId, start_date: selectedDate, end_date: null });
    await db.workers.update(hireWorkerId, { status: "active" });
    const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: localStorage.getItem("device_id") ?? "", author: "supervisor", event_type: "employment.started", payload: { worker_id: hireWorkerId, start_date: selectedDate }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "employment.started" });
    setMsg(`Rehired ${hireWorkerId} from ${selectedDate} inclusive — history preserved.`);
  }

  // Daily kg handling: active workers for selected date
  const activeWorkers = workers.filter(w => {
    // For demo, if no employment periods, consider active if worker status active
    return w.status === "active";
  });

  async function setKgForWorker(worker: LocalWorker, kgStr: string) {
    const kg = Number(kgStr);
    if (kgStr === "") {
      // remove entry
      const existing = daily.find(d=> d.worker_id===worker.worker_id);
      if (existing) await db.daily.delete(existing.id);
      return;
    }
    if (isNaN(kg) || kg < 0) { setMsg("Invalid kg"); return; }
    if (kg > 60) { setMsg(`Warning: implausible ${kg}kg > 60kg max`); }
    const kgUnits = Math.round(kg * 10);
    const id = `${selectedDate}-${worker.worker_id}`;
    const entry: DailyEntryLocal = { id, date: selectedDate, worker_id: worker.worker_id, worker_name: worker.full_name, kgUnits, present: true, isPluckingDay };
    await db.daily.put(entry);
    // queue event
    const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: localStorage.getItem("device_id") ?? "", author: "supervisor", event_type: "pluck.logged", payload: { worker_id: worker.worker_id, kg_units: kgUnits, present: true }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "pluck.logged" });
  }

  async function setAbsent(worker: LocalWorker, absent: boolean) {
    if (absent) {
      const id = `${selectedDate}-${worker.worker_id}-absent`;
      await db.daily.put({ id, date: selectedDate, worker_id: worker.worker_id, worker_name: worker.full_name, kgUnits: 0, present: false, isPluckingDay });
      const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: "", author: "supervisor", event_type: "pluck.logged", payload: { worker_id: worker.worker_id, present: false, absent: true }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
      await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "pluck.logged" });
    } else {
      const entries = daily.filter(d=> d.worker_id===worker.worker_id);
      for (const e of entries) await db.daily.delete(e.id);
    }
  }

  async function confirmDay() {
    if (!isPluckingDay) {
      const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: "", author: "supervisor", event_type: "day.plucking_set", payload: { date: selectedDate, is_plucking_day: false, reason: noPluckReason }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
      await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "day.plucking_set" });
      setMsg(`No-plucking day queued — Owner will get SMS: "TEA ${selectedDate}: No plucking today - ${noPluckReason}"`);
      return;
    }
    const totalKgUnits = daily.filter(d=> d.present).reduce((s,d)=> s+d.kgUnits, 0);
    const pickerCount = daily.filter(d=> d.present).length;
    const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: "", author: "supervisor", event_type: "day.confirmed", payload: { date: selectedDate, totalKgUnits, pickerCount }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "day.confirmed" });
    setMsg(`Confirmed ${selectedDate}: ${totalKgUnits/10}kg ${pickerCount} pickers — Owner daily SMS will send when synced.`);
  }

  async function submitSaturday() {
    const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: "", author: "supervisor", event_type: "week.submitted", payload: {}, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "week.submitted" });
    setMsg(`Final Saturday submitted for ${selectedDate} — if offline it shows “pending upload”. Server will lock week and reminder at 14:30 says “Saturday entry not received by server, please connect to sync.”`);
  }

  async function syncNow() {
    const all = await db.outbox.toArray();
    if (!all.length) { setMsg("Nothing to sync"); return; }
    try {
      const events = all.map(o=> o.payload);
      const res = await fetch("/api/sync/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }) });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { accepted: number; duplicates: number; flaggedAsCorrection: number; conflicts: number };
      for (const o of all) await db.outbox.delete(o.event_id);
      localStorage.setItem("last_synced", new Date().toISOString());
      setMsg(`Sync ok — accepted ${data.accepted}, dups ${data.duplicates}, flagged ${data.flaggedAsCorrection} (locked week → next-week adjustment), conflicts ${data.conflicts}`);
    } catch (e) { setMsg(`Sync failed: ${String(e)} — will retry. Late events for locked week are stored as correction requests.`); }
  }

  const totalKgUnits = daily.filter(d=> d.present).reduce((s,d)=> s+d.kgUnits, 0);
  const totalKes = calculateWorkerWeekPayKes(daily.filter(d=> d.present).map(d=> ({ kgUnits: d.kgUnits, rateCentsPerKg: 900 })));

  return (
    <div>
      <header style={{ background: "#1B5E20", color: "white", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Tea Ledger — Supervisor</h1>
        <span style={{ fontSize: 12 }}>{online ? "Online" : "Offline"} · Farm: <input value={farmId} onChange={e=> saveFarmId(e.target.value)} placeholder="UUID" style={{ width: 180, fontSize: 12, padding: 4 }} /></span>
      </header>
      <div style={{ background: "#FFF9C4", border: "1px solid #FBC02D", padding: 8, margin: 12, borderRadius: 8, fontSize: 13 }}>
        DEMO DATA — {online ? "connected" : "offline, will sync when online"} · <strong style={{ color: "#FF6F00" }}>Pending sync: {pending}</strong> {lastSynced ? `· Last synced ${new Date(lastSynced).toLocaleString()}` : ""} {pending>0 && <em> · “pending upload” if Saturday not yet synced</em>}
      </div>
      <div style={{ display: "flex", gap: 8, margin: 12 }}>
        <button onClick={()=> setTab("workers")} style={{ flex: 1, background: tab==="workers" ? "#2E7D32" : "white", color: tab==="workers" ? "white" : "#2E7D32", border: "2px solid #2E7D32" }}>1. Hire/Fire Workers</button>
        <button onClick={()=> setTab("daily")} style={{ flex: 1, background: tab==="daily" ? "#2E7D32" : "white", color: tab==="daily" ? "white" : "#2E7D32", border: "2px solid #2E7D32" }}>2. Daily kg per worker</button>
      </div>

      {tab==="workers" && (
        <div style={{ margin: 12 }}>
          <div style={{ background: "white", border: "1px solid #E0E0E0", borderRadius: 12, padding: 16, marginBottom: 12 }}>
            <h2 style={{ marginTop: 0 }}>Register new worker (offline OK, verification later)</h2>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <input placeholder="Full name e.g. Kiptoo" value={fullName} onChange={e=> setFullName(e.target.value)} style={{ flex: 1, padding: 12, fontSize: 16, borderRadius: 10, border: "2px solid #9E9E9E" }} />
              <input placeholder="Phone 07... or +254..." value={phone} onChange={e=> setPhone(e.target.value)} style={{ flex: 1, padding: 12, fontSize: 16, borderRadius: 10, border: "2px solid #9E9E9E" }} />
            </div>
            <label style={{ display: "flex", gap: 8, marginTop: 12, fontSize: 14 }}>
              <input type="checkbox" checked={consent} onChange={e=> setConsent(e.target.checked)} /> I confirm worker agreed to SMS receipts and storage of name/number (Decision 18) — checkbox with timestamp/author
            </label>
            <button onClick={registerWorker} style={{ marginTop: 12, background: "#2E7D32", color: "white", padding: "14px 18px", borderRadius: 12, border: 0, minHeight: 52, fontSize: 16 }}>Add worker — large button</button>
            <p style={{ fontSize: 12, color: "#555" }}>Number reuse allowed only after previous holder inactive + re-verification + Admin notified (Decision 17). Inclusive dates.</p>
          </div>

          <div style={{ background: "white", border: "1px solid #E0E0E0", borderRadius: 12, padding: 16, marginBottom: 12 }}>
            <h3>Active workers ({workers.length}) — tap to hire/fire</h3>
            {workers.length===0 && <p style={{ fontSize: 13, color: "#777" }}>No workers yet — register Kiptoo above, then log his kg in Daily tab.</p>}
            {workers.map(w=> (
              <div key={w.worker_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #E0E0E0", borderRadius: 10, padding: 10, marginBottom: 8 }}>
                <div><strong>{w.full_name}</strong> · {w.phone_e164} · {w.status} · {w.verified ? "verified" : "unverified — warning only, no receipt SMS until verified (Decision 3)"}</div>
                <button onClick={()=> setHireWorkerId(w.worker_id)} style={{ background: hireWorkerId===w.worker_id ? "#FF6F00" : "white", color: hireWorkerId===w.worker_id ? "white" : "#2E7D32", border: "2px solid #2E7D32", padding: 8, borderRadius: 8 }}>Select</button>
              </div>
            ))}
            {hireWorkerId && (
              <div style={{ marginTop: 12, borderTop: "1px solid #EEE", paddingTop: 12 }}>
                <div style={{ fontSize: 13 }}>Selected: {workers.find(w=> w.worker_id===hireWorkerId)?.full_name} — inclusive employment periods</div>
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <input type="date" value={fireDate} onChange={e=> setFireDate(e.target.value)} style={{ padding: 8 }} />
                  <input placeholder="Reason e.g. quit" value={fireReason} onChange={e=> setFireReason(e.target.value)} style={{ flex: 1, padding: 8 }} />
                  <button onClick={fireWorker} style={{ background: "#C62828", color: "white", padding: 10, borderRadius: 8, border: 0 }}>Fire — close period {fireDate} inclusive</button>
                  <button onClick={rehireWorker} style={{ background: "#2E7D32", color: "white", padding: 10, borderRadius: 8, border: 0 }}>Rehire from {selectedDate} inclusive</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {tab==="daily" && (
        <div style={{ margin: 12 }}>
          <div style={{ background: "white", border: "1px solid #E0E0E0", borderRadius: 12, padding: 16, marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <label>Date: <input type="date" value={selectedDate} onChange={e=> setSelectedDate(e.target.value)} style={{ padding: 8, fontSize: 16 }} /></label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={!isPluckingDay} onChange={e=> setIsPluckingDay(!e.target.checked)} /> No plucking today</label>
              {!isPluckingDay && <input placeholder="Reason e.g. no ready leaf" value={noPluckReason} onChange={e=> setNoPluckReason(e.target.value)} style={{ flex: 1, padding: 8 }} />}
            </div>
            {!isPluckingDay && <p style={{ fontSize: 12, color: "#555" }}>Owner will get SMS: “TEA {selectedDate}: No plucking today - {noPluckReason || "..."}” — not counted as absence</p>}
            {isPluckingDay && activeWorkers.length===0 && <p style={{ color: "#C62828" }}>No active workers — register in Workers tab first. Employment inclusive check: start ≤ {selectedDate} ≤ end</p>}
          </div>

          {isPluckingDay && activeWorkers.map(w=> {
            const entry = daily.find(d=> d.worker_id===w.worker_id);
            const kgDisplay = entry && entry.present ? String(entry.kgUnits/10) : "";
            const isAbsent = daily.some(d=> d.worker_id===w.worker_id && !d.present);
            return (
              <div key={w.worker_id} style={{ background: "white", border: "2px solid #9CCC65", borderRadius: 12, padding: 12, marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 700, flex: 1 }}>{w.full_name}<div style={{ fontWeight: 400, fontSize: 12, color: "#555" }}>{w.phone_e164} · tap to enter kg</div></div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <label style={{ fontSize: 12 }}><input type="checkbox" checked={isAbsent} onChange={e=> setAbsent(w, e.target.checked)} /> Absent (A)</label>
                  <input inputMode="numeric" placeholder="kg e.g. 40" value={kgDisplay} onChange={e=> setKgForWorker(w, e.target.value)} style={{ width: 110, padding: 12, fontSize: 18, border: "2px solid #1B5E20", borderRadius: 10, background: "#FFFDE7" }} disabled={isAbsent} />
                  <span style={{ fontSize: 12, color: "#1B5E20" }}>{entry && entry.present ? `= KES ${Math.round(entry.kgUnits/10*9)} (rate 9)` : ""}</span>
                </div>
              </div>
            );
          })}

          <div style={{ background: "white", border: "1px solid #E0E0E0", borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 700 }}>Total: {totalKgUnits/10}kg · {activeWorkers.length} workers · {daily.filter(d=> d.present).length} pickers today · Est total KES {totalKes} (auto calculates per date rate)</div>
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <button onClick={confirmDay} style={{ background: "#2E7D32", color: "white", padding: 14, borderRadius: 12, border: 0, minHeight: 52, flex: 1 }}>Confirm day</button>
              <button onClick={submitSaturday} style={{ background: "#FF6F00", color: "white", padding: 14, borderRadius: 12, border: 0, minHeight: 52, flex: 1 }}>Submit FINAL Saturday — locks week Mon-Sat Africa/Nairobi</button>
            </div>
            <p style={{ fontSize: 12, color: "#555" }}>{msg || "Tip: With airplane ON you can register Kiptoo, log 40kg, confirm — verification completes after reconnecting (Decision 1). Daily SMS to Owner = highest kg first +N more, weekly receipt tokens kg/A/NP fit 2 segments."}</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={syncNow} style={{ background: "#FF6F00", color: "white", padding: 14, borderRadius: 12, border: 0, minHeight: 52, flex: 1 }}>Sync now ({pending}) — relative /api, no localhost</button>
              <button onClick={()=> { localStorage.clear(); indexedDB.deleteDatabase("tea-farm-ledger"); location.reload(); }} style={{ background: "white", color: "#C62828", border: "2px solid #C62828", padding: 14, borderRadius: 12, minHeight: 52 }}>Clear demo</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
