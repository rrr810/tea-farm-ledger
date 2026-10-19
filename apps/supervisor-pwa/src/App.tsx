import { useEffect, useState } from "react";
import { db, todayEAT } from "./db.js";
import type { LocalWorker, DailyEntryLocal } from "./db.js";
import { normalizeKePhone, calculateWorkerWeekPayKes } from "@tea-ledger/core";

type Tab = "daily" | "workers";

export default function App() {
  const [tab, setTab] = useState<Tab>("daily");
  const [pending, setPending] = useState(0);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [farmId, setFarmId] = useState(localStorage.getItem("farm_id") ?? "");
  const [farmName, setFarmName] = useState(localStorage.getItem("farm_name") ?? "");
  const [workers, setWorkers] = useState<LocalWorker[]>([]);
  const [selectedDate, setSelectedDate] = useState(todayEAT());
  const [isPluckingDay, setIsPluckingDay] = useState(true);
  const [noPluckReason, setNoPluckReason] = useState("");
  const [daily, setDaily] = useState<DailyEntryLocal[]>([]);
  const [msg, setMsg] = useState("");
  const [msgType, setMsgType] = useState<"info" | "error" | "success">("info");

  // forms
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [showAddWorker, setShowAddWorker] = useState(false);
  const [selectedWorkerId, setSelectedWorkerId] = useState("");
  const [fireDate, setFireDate] = useState(todayEAT());
  const [fireReason, setFireReason] = useState("");

  function setToast(text: string, type: "info" | "error" | "success" = "info") {
    setMsg(text);
    setMsgType(type);
    if (text) setTimeout(() => setMsg(""), 4000);
  }

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
    }, 800);
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
      } catch { }
    }
  }

  async function createFarm() {
    if (!online) { setToast("Connect to internet to create farm", "error"); return; }
    try {
      const name = farmName.trim() || "Tea Farm";
      const res = await fetch("/api/farms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { farm_id: string };
      saveFarmId(data.farm_id);
      localStorage.setItem("farm_name", name);
      setFarmName(name);
      setToast(`Farm "${name}" created — ready to add workers`, "success");
    } catch (e) { setToast(`Failed: ${String(e)}`, "error"); }
  }

  async function registerWorker() {
    const norm = normalizeKePhone(phone);
    if (!norm.ok) { setToast(`Phone invalid: ${norm.reason} — use 07... or +254...`, "error"); return; }
    if (!fullName.trim()) { setToast("Enter worker name", "error"); return; }
    if (!consent) { setToast("Tick consent — worker agreed to SMS", "error"); return; }
    if (!farmId) { setToast("Create or enter Farm ID first (top bar)", "error"); return; }
    // Check duplicate phone among active workers
    const dup = workers.find(w => w.phone_e164 === norm.e164 && w.status === "active");
    if (dup) { setToast(`${dup.full_name} already uses ${norm.e164} and is active — cannot reuse until inactive`, "error"); return; }
    const worker_id = crypto.randomUUID();
    const worker: LocalWorker = { worker_id, farm_id: farmId, full_name: fullName.trim(), phone_e164: norm.e164, status: "active", verified: false, consent_at: new Date().toISOString(), consent_author: "supervisor" };
    await db.workers.put(worker);
    const event_id = crypto.randomUUID();
    const ev = { event_id, farm_id: farmId, device_id: localStorage.getItem("device_id") ?? crypto.randomUUID(), author: "supervisor", event_type: "worker.registered", payload: { worker_id, full_name: worker.full_name, phone_e164: worker.phone_e164, consent: true, consent_at: worker.consent_at, consent_author: worker.consent_author }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "worker.registered" });
    const empId = crypto.randomUUID();
    await db.employment.add({ id: empId, worker_id, farm_id: farmId, start_date: selectedDate, end_date: null });
    const empEv = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: localStorage.getItem("device_id") ?? "", author: "supervisor", event_type: "employment.started", payload: { worker_id, start_date: selectedDate }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: empEv.event_id, farm_id: farmId, payload: empEv, createdAt: new Date().toISOString(), type: "employment.started" });
    setToast(`${worker.full_name} added — will sync when online`, "success");
    setFullName(""); setPhone(""); setConsent(false); setShowAddWorker(false);
  }

  async function fireWorker() {
    if (!selectedWorkerId) { setToast("Select a worker", "error"); return; }
    const period = await db.employment.where("worker_id").equals(selectedWorkerId).filter(p => p.end_date === null).first();
    if (!period) { setToast("No active period for this worker", "error"); return; }
    if (fireDate < period.start_date) { setToast("End date cannot be before start date", "error"); return; }
    await db.employment.update(period.id, { end_date: fireDate });
    const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: localStorage.getItem("device_id") ?? "", author: "supervisor", event_type: "employment.ended", payload: { worker_id: selectedWorkerId, end_date: fireDate, reason: fireReason }, business_date: fireDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "employment.ended" });
    await db.workers.update(selectedWorkerId, { status: "inactive" });
    setToast(`Closed — ${period.start_date} to ${fireDate} inclusive. History kept.`, "success");
    setSelectedWorkerId("");
  }

  async function rehireWorker() {
    if (!selectedWorkerId) { setToast("Select a worker", "error"); return; }
    const periods = await db.employment.where("worker_id").equals(selectedWorkerId).toArray();
    if (periods.some(p => p.end_date === null)) { setToast("Already active", "error"); return; }
    const lastEnd = periods.filter(p => p.end_date).sort((a, b) => (a.end_date as string).localeCompare(b.end_date as string)).pop();
    if (lastEnd && selectedDate <= (lastEnd.end_date as string)) { setToast(`Start must be after ${lastEnd.end_date}`, "error"); return; }
    const id = crypto.randomUUID();
    await db.employment.add({ id, worker_id: selectedWorkerId, farm_id: farmId, start_date: selectedDate, end_date: null });
    await db.workers.update(selectedWorkerId, { status: "active" });
    const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: localStorage.getItem("device_id") ?? "", author: "supervisor", event_type: "employment.started", payload: { worker_id: selectedWorkerId, start_date: selectedDate }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "employment.started" });
    setToast(`Rehired from ${selectedDate} — history preserved`, "success");
    setSelectedWorkerId("");
  }

  const activeWorkers = workers.filter(w => w.status === "active");

  async function setKgForWorker(worker: LocalWorker, kgStr: string) {
    const kg = Number(kgStr);
    if (kgStr === "") {
      const existing = daily.find(d => d.worker_id === worker.worker_id && d.present);
      if (existing) await db.daily.delete(existing.id);
      return;
    }
    if (isNaN(kg) || kg < 0) { setToast("Enter valid kg (e.g. 12.5)", "error"); return; }
    if (kg > 60) { setToast(`Heads up: ${kg}kg is unusually high (max 60)`, "info"); }
    const kgUnits = Math.round(kg * 10);
    const id = `${selectedDate}-${worker.worker_id}`;
    const entry: DailyEntryLocal = { id, date: selectedDate, worker_id: worker.worker_id, worker_name: worker.full_name, kgUnits, present: true, isPluckingDay };
    await db.daily.put(entry);
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
      const entries = daily.filter(d => d.worker_id === worker.worker_id);
      for (const e of entries) await db.daily.delete(e.id);
    }
  }

  async function confirmDay() {
    if (!isPluckingDay) {
      if (!noPluckReason.trim()) { setToast("Add a reason (e.g. rains, no leaf)", "error"); return; }
      const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: "", author: "supervisor", event_type: "day.plucking_set", payload: { date: selectedDate, is_plucking_day: false, reason: noPluckReason }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
      await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "day.plucking_set" });
      setToast(`No-plucking saved — Owner gets SMS: “No plucking ${selectedDate}: ${noPluckReason}”`, "success");
      return;
    }
    if (daily.filter(d => d.present).length === 0) { setToast("Enter at least one worker's kg first", "error"); return; }
    const totalKgUnits = daily.filter(d => d.present).reduce((s, d) => s + d.kgUnits, 0);
    const pickerCount = daily.filter(d => d.present).length;
    const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: "", author: "supervisor", event_type: "day.confirmed", payload: { date: selectedDate, totalKgUnits, pickerCount }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "day.confirmed" });
    setToast(`Done — ${totalKgUnits / 10}kg, ${pickerCount} pickers. Owner SMS queued.`, "success");
  }

  async function submitSaturday() {
    const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id: "", author: "supervisor", event_type: "week.submitted", payload: {}, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "week.submitted" });
    setToast(`Saturday FINAL submitted — will show “pending upload” until synced`, "success");
  }

  async function syncNow() {
    const all = await db.outbox.toArray();
    if (!all.length) { setToast("All caught up — nothing to sync", "info"); return; }
    try {
      const events = all.map(o => o.payload);
      const res = await fetch("/api/sync/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }) });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { accepted: number; duplicates: number; flaggedAsCorrection: number; conflicts: number };
      for (const o of all) await db.outbox.delete(o.event_id);
      localStorage.setItem("last_synced", new Date().toISOString());
      setToast(`Synced ✓ ${data.accepted} new, ${data.duplicates} already had, ${data.flaggedAsCorrection} late → next week`, "success");
    } catch (e) { setToast(`Sync failed — will retry. ${String(e).slice(0, 120)}`, "error"); }
  }

  const totalKgUnits = daily.filter(d => d.present).reduce((s, d) => s + d.kgUnits, 0);
  const pickerCount = daily.filter(d => d.present).length;
  const totalKes = calculateWorkerWeekPayKes(daily.filter(d => d.present).map(d => ({ kgUnits: d.kgUnits, rateCentsPerKg: 900 })));

  return (
    <div style={{ minHeight: "100vh", background: "#F5F7F0", fontFamily: "system-ui, -apple-system, sans-serif", color: "#1A1A1A" }}>
      {/* Top bar — clean, real */}
      <header style={{ background: "#1B4332", color: "white", padding: "14px 16px", position: "sticky", top: 0, zIndex: 10, boxShadow: "0 2px 8px rgba(0,0,0,0.15)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", maxWidth: 720, margin: "0 auto", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "white", color: "#1B4332", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 16 }}>T</div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 16, lineHeight: 1 }}>Tea Ledger</div>
              <div style={{ fontSize: 11, opacity: 0.85 }}>{farmName || "Supervisor"} · {online ? "● Online" : "○ Offline"}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flex: 1, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <input value={farmId} onChange={e => saveFarmId(e.target.value)} placeholder="Farm ID" style={{ width: 140, fontSize: 12, padding: "6px 8px", borderRadius: 8, border: 0, background: "rgba(255,255,255,0.15)", color: "white" }} />
            <button onClick={createFarm} style={{ fontSize: 12, padding: "7px 12px", borderRadius: 20, border: 0, background: "white", color: "#1B4332", fontWeight: 700, cursor: "pointer" }}>+ New farm</button>
          </div>
        </div>
      </header>

      {/* Sync status — subtle, real */}
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "10px 16px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "#5A6B5A", background: "white", border: "1px solid #E3E8DD", borderRadius: 10, padding: "8px 12px" }}>
          <span>{pending > 0 ? <><span style={{ color: "#C67C00", fontWeight: 700 }}>● {pending} to sync</span><span style={{ marginLeft: 8, opacity: 0.7 }}>pending upload</span></> : <span style={{ color: "#2D6A4F", fontWeight: 600 }}>✓ Up to date</span>}{lastSynced ? <span style={{ marginLeft: 10, opacity: 0.6 }}>· {new Date(lastSynced).toLocaleTimeString()}</span> : ""}</span>
          <button onClick={syncNow} style={{ background: pending ? "#E9B44C" : "#E8F5E9", color: pending ? "#5A3E00" : "#2D6A4F", border: 0, borderRadius: 20, padding: "6px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Sync now</button>
        </div>
        {msg && <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: 10, fontSize: 13, fontWeight: 500, background: msgType === "error" ? "#FDEDEC" : msgType === "success" ? "#E8F5E9" : "#FFF8E1", color: msgType === "error" ? "#922B21" : msgType === "success" ? "#1B4D3E" : "#5D4037", border: `1px solid ${msgType === "error" ? "#F5B7B1" : msgType === "success" ? "#A9DFBF" : "#FFE0B2"}` }}>{msg}</div>}
      </div>

      {/* DAILY is hero */}
      <div style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
        {/* Date + plucking toggle — big, clear */}
        <div style={{ background: "white", borderRadius: 16, padding: 16, boxShadow: "0 1px 6px rgba(0,0,0,0.07)", border: "1px solid #E8E8E0", marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: "#6B7D6B", fontWeight: 700 }}>Today</div>
              <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} style={{ marginTop: 6, padding: "10px 12px", fontSize: 16, fontWeight: 700, border: "2px solid #2D6A4F", borderRadius: 12, background: "#F0F7F0", minWidth: 160 }} />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 10, background: !isPluckingDay ? "#FFF3E0" : "#F1F8F1", border: `2px solid ${!isPluckingDay ? "#E9B44C" : "#C8E6C9"}`, padding: "10px 14px", borderRadius: 12, cursor: "pointer" }}>
              <input type="checkbox" checked={!isPluckingDay} onChange={e => setIsPluckingDay(!e.target.checked)} style={{ width: 18, height: 18, accentColor: "#E9B44C" }} />
              <span style={{ fontWeight: 700, fontSize: 13, color: !isPluckingDay ? "#7A4A00" : "#2E7D32" }}>{!isPluckingDay ? "No plucking today" : "Plucking day"}</span>
            </label>
          </div>
          {!isPluckingDay && (
            <div style={{ marginTop: 12 }}>
              <input placeholder="Why? e.g. heavy rain, no ready leaf" value={noPluckReason} onChange={e => setNoPluckReason(e.target.value)} style={{ width: "100%", padding: "12px 14px", fontSize: 15, borderRadius: 10, border: "2px solid #E9B44C", background: "#FFFBF0", boxSizing: "border-box" }} />
              <div style={{ fontSize: 12, color: "#8A6A2A", marginTop: 6 }}>Owner gets SMS: “No plucking {selectedDate}: {noPluckReason || "—"}”</div>
            </div>
          )}
        </div>

        {/* Workers kg list — THE MAIN THING */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: "#1B4332", letterSpacing: 0.3 }}>Today’s pick</h2>
          <span style={{ fontSize: 12, color: "#6B7D6B", background: "white", padding: "4px 10px", borderRadius: 20, border: "1px solid #E0E0E0" }}>{activeWorkers.length} active</span>
        </div>

        {isPluckingDay && activeWorkers.length === 0 && (
          <div style={{ background: "white", borderRadius: 16, padding: 24, textAlign: "center", border: "2px dashed #C8D6C8" }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🌿</div>
            <div style={{ fontWeight: 700, color: "#1B4332" }}>No workers yet</div>
            <div style={{ fontSize: 13, color: "#6B7D6B", marginTop: 6 }}>Add your first picker below to start logging</div>
            <button onClick={() => { setTab("workers"); setShowAddWorker(true); }} style={{ marginTop: 14, background: "#2D6A4F", color: "white", padding: "12px 20px", borderRadius: 12, border: 0, fontWeight: 700, cursor: "pointer" }}>Add worker</button>
          </div>
        )}

        {isPluckingDay && activeWorkers.map(w => {
          const entry = daily.find(d => d.worker_id === w.worker_id && d.present);
          const kgDisplay = entry ? String(entry.kgUnits / 10) : "";
          const isAbsent = daily.some(d => d.worker_id === w.worker_id && !d.present);
          const inputId = `kg-${w.worker_id}`;
          const initials = w.full_name.split(" ").map(s => s[0]).join("").slice(0, 2).toUpperCase();
          return (
            <div key={w.worker_id} onClick={() => !isAbsent && document.getElementById(inputId)?.focus()} style={{ background: "white", borderRadius: 16, padding: 14, marginBottom: 10, display: "flex", alignItems: "center", gap: 12, border: entry ? "2px solid #2D6A4F" : "1px solid #E8E8E0", boxShadow: entry ? "0 2px 8px rgba(45,106,79,0.12)" : "0 1px 3px rgba(0,0,0,0.05)", cursor: isAbsent ? "default" : "pointer" }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: entry ? "#2D6A4F" : "#EFF6EC", color: entry ? "white" : "#2D6A4F", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 14, flexShrink: 0 }}>{initials}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 15, color: "#1A1A1A", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.full_name}</div>
                <div style={{ fontSize: 11, color: "#7A8A7A" }}>{w.phone_e164} · {entry ? `${kgDisplay} kg` : isAbsent ? "Absent" : "tap to enter"}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                <label title="Mark absent" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: isAbsent ? "#C62828" : "#8A8A8A", cursor: "pointer", background: isAbsent ? "#FDEDEC" : "#F5F5F0", padding: "6px 8px", borderRadius: 8, border: `1px solid ${isAbsent ? "#F5B7B1" : "#E0E0E0"}` }}>
                  <input type="checkbox" checked={isAbsent} onChange={e => setAbsent(w, e.target.checked)} style={{ width: 14, height: 14 }} /> Absent
                </label>
                <input id={inputId} data-testid={`kg-${w.worker_id}`} inputMode="decimal" type="text" placeholder="kg" value={kgDisplay} onChange={e => setKgForWorker(w, e.target.value)} disabled={isAbsent} style={{ width: 84, padding: "12px 10px", fontSize: 18, fontWeight: 800, textAlign: "center", border: `2px solid ${entry ? "#2D6A4F" : "#B7CBBF"}`, borderRadius: 12, background: isAbsent ? "#F5F5F0" : entry ? "#F0F7F0" : "#FFFDE7", color: "#1B4332", outline: "none" }} />
                <div style={{ fontSize: 12, fontWeight: 700, color: "#2D6A4F", minWidth: 64, textAlign: "right" }}>{entry ? `KES ${Math.round(entry.kgUnits / 10 * 9)}` : ""}</div>
              </div>
            </div>
          );
        })}

        {/* Totals — prominent */}
        {isPluckingDay && activeWorkers.length > 0 && (
          <div style={{ background: "#1B4332", color: "white", borderRadius: 16, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
            <div>
              <div style={{ fontSize: 11, opacity: 0.8, letterSpacing: 0.8, textTransform: "uppercase" }}>Today total</div>
              <div style={{ fontSize: 22, fontWeight: 900, marginTop: 2 }}>{totalKgUnits / 10} <span style={{ fontSize: 12, opacity: 0.8, fontWeight: 600 }}>kg</span> · {pickerCount} pickers</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, opacity: 0.8 }}>Est. pay (×9)</div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>KES {totalKes.toLocaleString()}</div>
            </div>
          </div>
        )}

        {/* Actions — big, thumb-friendly */}
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button data-testid="confirm-day" onClick={confirmDay} style={{ flex: 1, background: "#2D6A4F", color: "white", padding: "16px 12px", borderRadius: 14, border: 0, fontWeight: 800, fontSize: 15, cursor: "pointer", boxShadow: "0 2px 8px rgba(45,106,79,0.3)" }}>✓ Confirm day</button>
          <button data-testid="submit-saturday" onClick={submitSaturday} style={{ flex: 1, background: "white", color: "#7A4A00", padding: "16px 12px", borderRadius: 14, border: "2px solid #E9B44C", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>Submit Saturday FINAL</button>
        </div>
        <div style={{ fontSize: 11, color: "#8A8A8A", textAlign: "center", marginTop: 8 }}>Weekly pay locks Sat night — late edits become next-week adjustment</div>

        {/* Simple workers section — not stealing show */}
        <div style={{ marginTop: 24, background: "white", borderRadius: 16, border: "1px solid #E8E8E0", overflow: "hidden" }}>
          <button onClick={() => setTab(tab === "workers" ? "daily" : "workers")} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", background: "white", border: 0, cursor: "pointer", textAlign: "left" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 18 }}>👥</span>
              <span style={{ fontWeight: 700, fontSize: 14, color: "#1B4332" }}>Workers</span>
              <span style={{ fontSize: 11, background: "#EFF6EC", color: "#2D6A4F", padding: "3px 8px", borderRadius: 20, fontWeight: 700 }}>{workers.length}</span>
            </div>
            <span style={{ color: "#8A8A8A", fontSize: 12 }}>{tab === "workers" ? "▲ Hide" : "▼ Manage"}</span>
          </button>

          {tab === "workers" && (
            <div style={{ padding: 16, borderTop: "1px solid #F0F0EA", background: "#FAFAF7" }}>
              {!showAddWorker ? (
                <button data-testid="show-add-worker" onClick={() => setShowAddWorker(true)} style={{ width: "100%", background: "white", border: "2px dashed #2D6A4F", color: "#2D6A4F", padding: "14px", borderRadius: 12, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>+ Add worker</button>
              ) : (
                <div style={{ background: "white", borderRadius: 12, padding: 14, border: "1px solid #E0E0E0" }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: "#1B4332" }}>Add picker</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input data-testid="worker-name" placeholder="Name e.g. Kiptoo" value={fullName} onChange={e => setFullName(e.target.value)} style={{ flex: "1 1 140px", padding: "12px 14px", fontSize: 15, borderRadius: 10, border: "2px solid #D5DDD5", background: "white" }} />
                    <input data-testid="worker-phone" placeholder="07... or +254..." value={phone} onChange={e => setPhone(e.target.value)} style={{ flex: "1 1 140px", padding: "12px 14px", fontSize: 15, borderRadius: 10, border: "2px solid #D5DDD5", background: "white" }} />
                  </div>
                  <label style={{ display: "flex", gap: 8, marginTop: 12, fontSize: 12, color: "#4A5A4A", cursor: "pointer" }}>
                    <input data-testid="consent" type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} style={{ width: 18, height: 18, accentColor: "#2D6A4F" }} />
                    <span>Worker agreed to SMS receipts & storage of name/number</span>
                  </label>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button data-testid="add-worker" onClick={registerWorker} style={{ flex: 1, background: "#2D6A4F", color: "white", padding: "13px", borderRadius: 10, border: 0, fontWeight: 800, fontSize: 15, cursor: "pointer" }}>Add worker</button>
                    <button onClick={() => { setShowAddWorker(false); setFullName(""); setPhone(""); }} style={{ padding: "13px 16px", borderRadius: 10, border: "1px solid #D5DDD5", background: "white", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
                  </div>
                </div>
              )}

              <div style={{ marginTop: 16 }}>
                {workers.length === 0 && <div style={{ fontSize: 13, color: "#8A8A8A", textAlign: "center", padding: 12 }}>No workers yet</div>}
                {workers.map(w => (
                  <div key={w.worker_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "white", border: selectedWorkerId === w.worker_id ? "2px solid #2D6A4F" : "1px solid #E8E8E0", borderRadius: 12, padding: "10px 12px", marginBottom: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>{w.full_name} <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 20, background: w.status === "active" ? "#E8F5E9" : "#F5F5F0", color: w.status === "active" ? "#2E7D32" : "#8A8A8A", border: `1px solid ${w.status === "active" ? "#A5D6A7" : "#E0E0E0"}` }}>{w.status}</span></div>
                      <div style={{ fontSize: 11, color: "#7A8A7A" }}>{w.phone_e164}</div>
                    </div>
                    <button onClick={() => setSelectedWorkerId(w.worker_id === selectedWorkerId ? "" : w.worker_id)} style={{ background: selectedWorkerId === w.worker_id ? "#2D6A4F" : "white", color: selectedWorkerId === w.worker_id ? "white" : "#2D6A4F", border: "1.5px solid #2D6A4F", padding: "7px 12px", borderRadius: 20, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>{selectedWorkerId === w.worker_id ? "Selected" : "Manage"}</button>
                  </div>
                ))}
                {selectedWorkerId && (
                  <div style={{ background: "white", border: "1px solid #E0E0E0", borderRadius: 12, padding: 12, marginTop: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#1B4332" }}>{workers.find(w => w.worker_id === selectedWorkerId)?.full_name}</div>
                    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                      <input type="date" value={fireDate} onChange={e => setFireDate(e.target.value)} style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #D5DDD5", fontSize: 13 }} />
                      <input placeholder="Reason" value={fireReason} onChange={e => setFireReason(e.target.value)} style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid #D5DDD5", fontSize: 13 }} />
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                      <button onClick={fireWorker} style={{ flex: 1, background: "#FFF3F3", color: "#C62828", padding: "10px", borderRadius: 8, border: "1.5px solid #EF9A9A", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>End work</button>
                      <button onClick={rehireWorker} style={{ flex: 1, background: "#2D6A4F", color: "white", padding: "10px", borderRadius: 8, border: 0, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Rehire</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div style={{ textAlign: "center", marginTop: 16, paddingBottom: 20 }}>
          <button onClick={() => { if (confirm("Clear local data? (farm & workers)")) { localStorage.clear(); indexedDB.deleteDatabase("tea-farm-ledger"); location.reload(); } }} style={{ fontSize: 12, color: "#8A8A8A", background: "none", border: 0, textDecoration: "underline", cursor: "pointer" }}>Reset local data</button>
        </div>
      </div>
    </div>
  );
}
