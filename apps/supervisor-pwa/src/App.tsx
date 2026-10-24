import { useEffect, useState, useRef } from "react";
import { db, todayEAT } from "./db.js";
import type { LocalWorker, DailyEntryLocal } from "./db.js";
import { normalizeKePhone, calculateWorkerWeekPayKes } from "@tea-ledger/core";

type Tab = "daily" | "workers";

function getDeviceId() {
  let id = localStorage.getItem("device_id");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("device_id", id); }
  return id;
}
function nextDateEAT(d: string) {
  // d is YYYY-MM-DD, add 1 day in EAT calendar (just ISO date math, no TZ shift needed)
  const date = new Date(d + "T12:00:00");
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}
function isSaturdayEAT(d: string) {
  const date = new Date(d + "T12:00:00");
  // Get day of week in Africa/Nairobi
  const day = new Date(date.toLocaleString("en-US", { timeZone: "Africa/Nairobi" })).getDay();
  // Actually simpler: getUTCDay of 12:00 UTC corresponds to ~15:00 EAT same date
  // Use Intl for correct
  const nairobiDay = new Date().toLocaleDateString("en-US", { timeZone: "Africa/Nairobi", weekday: "short" });
  // Fallback: compute from d directly as EAT date
  const dow = new Date(d + "T09:00:00Z").getUTCDay(); // 09Z = 12 EAT
  return dow === 6;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("daily");
  const [pending, setPending] = useState(0);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [farmId, setFarmId] = useState(localStorage.getItem("farm_id") ?? "");
  const [farmName, setFarmName] = useState(localStorage.getItem("farm_name") ?? "");
  const [workers, setWorkers] = useState<LocalWorker[]>([]);
  const [selectedDate, setSelectedDate] = useState(todayEAT());
  const [noPlucking, setNoPlucking] = useState(false);
  const [noPluckReason, setNoPluckReason] = useState("");
  const [daily, setDaily] = useState<DailyEntryLocal[]>([]);
  const [msg, setMsg] = useState("");
  const [msgType, setMsgType] = useState<"info" | "error" | "success">("info");
  const [syncing, setSyncing] = useState(false);
  const [dayDone, setDayDone] = useState(false);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [showAddWorker, setShowAddWorker] = useState(false);
  const [selectedWorkerId, setSelectedWorkerId] = useState("");
  const [fireDate, setFireDate] = useState(todayEAT());
  const [fireReason, setFireReason] = useState("");

  // Auto-sync debounce ref
  const autoSyncTimer = useRef<number | null>(null);

  function setToast(text: string, type: "info" | "error" | "success" = "info") {
    setMsg(text); setMsgType(type);
    if (text) setTimeout(() => setMsg(""), 5000);
  }

  useEffect(() => {
    const onO = () => setOnline(true);
    const onF = () => setOnline(false);
    window.addEventListener("online", onO);
    window.addEventListener("offline", onF);
    // Restore last done date check
    const doneKey = `done:${selectedDate}:${farmId}`;
    setDayDone(!!localStorage.getItem(doneKey));
    const id = setInterval(async () => {
      setPending(await db.outbox.count());
      setLastSynced(localStorage.getItem("last_synced"));
      setWorkers(await db.workers.toArray());
      setDaily(await db.daily.where("date").equals(selectedDate).toArray());
      setDayDone(!!localStorage.getItem(`done:${selectedDate}:${localStorage.getItem("farm_id")}`));
    }, 900);
    return () => { window.removeEventListener("online", onO); window.removeEventListener("offline", onF); clearInterval(id); };
  }, [selectedDate, farmId]);

  // Auto-sync: when online and pending and not syncing, and last action was Done (not half-day), sync in background
  useEffect(() => {
    if (!online || pending === 0 || syncing) return;
    // Only auto-sync if the oldest pending is from a completed day (day.confirmed or pluck with day done)
    // Simple: if we have dayDone or pending has day.confirmed, auto-sync
    // Check outbox for day.confirmed or pluck.logged that belongs to a done day
    db.outbox.toArray().then(items => {
      const hasDone = items.some(i => i.type === "day.confirmed" || i.type === "day.plucking_set" || i.type === "week.submitted");
      if (!hasDone) return; // don't send half-day kg alone — wait for Done
      if (autoSyncTimer.current) window.clearTimeout(autoSyncTimer.current);
      autoSyncTimer.current = window.setTimeout(() => { syncNow(true); }, 1200);
    });
  }, [pending, online]);

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
    const name = farmName.trim();
    if (!name) { setToast("Enter a clear farm label, e.g. TEST-5532", "error"); return; }
    try {
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
    const dup = workers.find(w => w.phone_e164 === norm.e164 && w.status === "active");
    if (dup) { setToast(`${dup.full_name} already uses ${norm.e164} — end that worker first`, "error"); return; }
    const worker_id = crypto.randomUUID();
    const worker: LocalWorker = { worker_id, farm_id: farmId, full_name: fullName.trim(), phone_e164: norm.e164, status: "active", verified: false, consent_at: new Date().toISOString(), consent_author: "supervisor" };
    await db.workers.put(worker);
    const device_id = getDeviceId();
    const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id, author: "supervisor", event_type: "worker.registered", payload: { worker_id, full_name: worker.full_name, phone_e164: worker.phone_e164, consent: true, consent_at: worker.consent_at, consent_author: worker.consent_author }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "worker.registered" });
    const empId = crypto.randomUUID();
    await db.employment.add({ id: empId, worker_id, farm_id: farmId, start_date: selectedDate, end_date: null });
    const empEv = { event_id: crypto.randomUUID(), farm_id: farmId, device_id, author: "supervisor", event_type: "employment.started", payload: { worker_id, start_date: selectedDate }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
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
    const device_id = getDeviceId();
    const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id, author: "supervisor", event_type: "employment.ended", payload: { worker_id: selectedWorkerId, end_date: fireDate, reason: fireReason }, business_date: fireDate, client_timestamp: new Date().toISOString() };
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
    const device_id = getDeviceId();
    const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id, author: "supervisor", event_type: "employment.started", payload: { worker_id: selectedWorkerId, start_date: selectedDate }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "employment.started" });
    setToast(`Rehired from ${selectedDate} — history preserved`, "success");
    setSelectedWorkerId("");
  }

  const activeWorkers = workers.filter(w => w.status === "active");

  // Local-only kg (no outbox until Done) — this prevents 17 to sync half-day issue
  async function setKgForWorker(worker: LocalWorker, kgStr: string) {
    const kg = Number(kgStr);
    if (kgStr === "") {
      const existing = daily.find(d => d.worker_id === worker.worker_id && d.present);
      if (existing) await db.daily.delete(existing.id);
      return;
    }
    if (isNaN(kg) || kg < 0) { setToast("Enter valid kg (e.g. 12.5)", "error"); return; }
    if (kg > 60) { setToast(`Heads up: ${kg}kg unusually high (max 60)`, "info"); }
    const kgUnits = Math.round(kg * 10);
    const id = `${selectedDate}-${worker.worker_id}`;
    const entry: DailyEntryLocal = { id, date: selectedDate, worker_id: worker.worker_id, worker_name: worker.full_name, kgUnits, present: true, isPluckingDay: !noPlucking };
    await db.daily.put(entry);
    // Do NOT queue to outbox here — only on Done for the day
  }
  async function setAbsent(worker: LocalWorker, absent: boolean) {
    if (absent) {
      const id = `${selectedDate}-${worker.worker_id}-absent`;
      await db.daily.put({ id, date: selectedDate, worker_id: worker.worker_id, worker_name: worker.full_name, kgUnits: 0, present: false, isPluckingDay: !noPlucking });
    } else {
      const entries = daily.filter(d => d.worker_id === worker.worker_id);
      for (const e of entries) await db.daily.delete(e.id);
    }
  }

  async function markDoneForDay() {
    if (noPlucking) {
      if (!noPluckReason.trim()) { setToast("Add reason: e.g. heavy rain, no leaf, holiday", "error"); return; }
      const device_id = getDeviceId();
      const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id, author: "supervisor", event_type: "day.plucking_set", payload: { date: selectedDate, is_plucking_day: false, reason: noPluckReason }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
      await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "day.plucking_set" });
      localStorage.setItem(`done:${selectedDate}:${farmId}`, "1");
      setDayDone(true);
      setToast(`Day closed — Owner SMS: “No plucking ${selectedDate}: ${noPluckReason}” — auto-syncing…`, "success");
      if (online) setTimeout(() => syncNow(false), 600);
      // Auto-roll to next day after 1.2s
      setTimeout(() => {
        const next = nextDateEAT(selectedDate);
        setSelectedDate(next); setNoPlucking(false); setNoPluckReason(""); setDayDone(false);
        setToast(`Rolled to ${next} — ready for next day. Yesterday’s data kept.`, "info");
      }, 1500);
      return;
    }
    const present = daily.filter(d => d.present);
    if (present.length === 0) { setToast("Enter at least one worker’s kg before Done", "error"); return; }
    const device_id = getDeviceId();
    // Queue all plucks + absents + NP as batch (only now, not on each keystroke)
    for (const d of daily) {
      if (d.present) {
        const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id, author: "supervisor", event_type: "pluck.logged", payload: { worker_id: d.worker_id, kg_units: d.kgUnits, present: true }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
        await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "pluck.logged" });
      } else {
        const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id, author: "supervisor", event_type: "pluck.logged", payload: { worker_id: d.worker_id, present: false, absent: true }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
        await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "pluck.logged" });
      }
    }
    const totalKgUnits = present.reduce((s, d) => s + d.kgUnits, 0);
    const pickerCount = present.length;
    const doneEv = { event_id: crypto.randomUUID(), farm_id: farmId, device_id, author: "supervisor", event_type: "day.confirmed", payload: { date: selectedDate, totalKgUnits, pickerCount }, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: doneEv.event_id, farm_id: farmId, payload: doneEv, createdAt: new Date().toISOString(), type: "day.confirmed" });
    localStorage.setItem(`done:${selectedDate}:${farmId}`, "1");
    setDayDone(true);
    setToast(`✓ Done — ${totalKgUnits / 10}kg, ${pickerCount} pickers queued. Auto-syncing…`, "success");
    if (online) setTimeout(() => syncNow(false), 700);
    // Auto-roll to next day
    setTimeout(() => {
      const next = nextDateEAT(selectedDate);
      setSelectedDate(next); setDayDone(false);
      setToast(`Next day ${next} — fresh sheet, yesterday kept in phone storage`, "info");
    }, 1800);
  }

  async function submitSaturday() {
    const dow = new Date(selectedDate + "T09:00:00Z").getUTCDay();
    if (dow !== 6) { setToast(`Today is not Saturday (${selectedDate}) — FINAL is only on Saturday`, "info"); return; }
    const device_id = getDeviceId();
    const ev = { event_id: crypto.randomUUID(), farm_id: farmId, device_id, author: "supervisor", event_type: "week.submitted", payload: {}, business_date: selectedDate, client_timestamp: new Date().toISOString() };
    await db.outbox.add({ event_id: ev.event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString(), type: "week.submitted" });
    setToast(`Saturday FINAL sent — week Mon–Sat locked. Late edits become next-week adjustment.`, "success");
    if (online) setTimeout(() => syncNow(false), 600);
  }

  async function syncNow(manual = true) {
    if (syncing) return;
    const all = await db.outbox.toArray();
    if (!all.length) { if (manual) setToast("All up to date — nothing to sync", "info"); return; }
    setSyncing(true);
    try {
      const events = all.map(o => o.payload);
      const res = await fetch("/api/sync/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }) });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { accepted: number; duplicates: number; flaggedAsCorrection: number; conflicts: number };
      for (const o of all) await db.outbox.delete(o.event_id);
      localStorage.setItem("last_synced", new Date().toISOString());
      setToast(manual ? `Synced ✓ ${data.accepted} new` : `Auto-synced ✓ ${data.accepted} sent — data safe in cloud`, "success");
    } catch (e) {
      const txt = String(e);
      if (txt.includes("uuid") || txt.includes("internal_error")) {
        // Clear bad outbox items (old buggy device_id "")
        // Keep only valid ones: remove items with empty device_id
        const bad = all.filter(o => !o.payload?.device_id);
        for (const b of bad) await db.outbox.delete(b.event_id);
        if (bad.length) { setToast(`Cleared ${bad.length} bad pending — retry Sync`, "info"); setSyncing(false); return; }
      }
      setToast(`Sync failed — will auto-retry. ${txt.slice(0, 140)}`, "error");
    } finally { setSyncing(false); }
  }

  const totalKgUnits = daily.filter(d => d.present).reduce((s, d) => s + d.kgUnits, 0);
  const pickerCount = daily.filter(d => d.present).length;
  const totalKes = calculateWorkerWeekPayKes(daily.filter(d => d.present).map(d => ({ kgUnits: d.kgUnits, rateCentsPerKg: 900 })));
  const saturday = isSaturdayEAT(selectedDate);

  return (
    <div style={{ minHeight: "100vh", background: "#FAF6EA", fontFamily: "system-ui, -apple-system, sans-serif", color: "#23231F" }}>
      <header style={{ background: "#1F4D2B", color: "white", padding: "14px 16px", position: "sticky", top: 0, zIndex: 10, boxShadow: "0 2px 8px rgba(0,0,0,0.15)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", maxWidth: 720, margin: "0 auto", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "#FFFDF6", color: "#1F4D2B", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 16 }}>T</div>
            <div><div style={{ fontWeight: 800, fontSize: 17, lineHeight: 1, fontFamily: "Georgia, 'Times New Roman', serif" }}>Tea Ledger</div><div style={{ fontSize: 11, opacity: 0.85 }}>{farmName || "Supervisor"} · {online ? "● Online" : "○ Offline"}{dayDone ? " · ✓ Done" : ""}</div></div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <input value={farmName} onChange={e => setFarmName(e.target.value)} aria-label="Farm label" placeholder="Farm label, e.g. TEST-5532" style={{ width: 166, fontSize: 11, padding: "6px 8px", borderRadius: 8, border: 0, background: "rgba(255,255,255,0.15)", color: "white" }} />
            <input value={farmId} onChange={e => saveFarmId(e.target.value)} aria-label="Farm ID" placeholder="Farm ID" style={{ width: 112, fontSize: 11, padding: "6px 8px", borderRadius: 8, border: 0, background: "rgba(255,255,255,0.15)", color: "white" }} />
            <button onClick={createFarm} data-testid="new-farm" style={{ fontSize: 12, padding: "7px 12px", borderRadius: 20, border: 0, background: "#FFFDF6", color: "#1F4D2B", fontWeight: 700, cursor: "pointer" }}>+ New farm</button>
          </div>
        </div>
      </header>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "10px 16px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "#5A6B5A", background: "#FFFDF6", border: "1px solid #D9D2BC", borderRadius: 10, padding: "8px 12px" }}>
          <span>{pending > 0 ? <><span style={{ color: "#C67C00", fontWeight: 700 }}>● {pending} to sync</span><span style={{ marginLeft: 8, opacity: 0.7 }}>pending upload</span></> : <span style={{ color: "#2D6A3E", fontWeight: 600 }}>✓ Up to date</span>}{lastSynced ? <span style={{ marginLeft: 10, opacity: 0.5 }}>· {new Date(lastSynced).toLocaleTimeString()}</span> : ""}{syncing ? " · syncing…" : ""}</span>
          <button onClick={() => syncNow(true)} disabled={syncing} style={{ background: pending ? "#E3A72F" : "#EAF3E2", color: pending ? "#5A3E00" : "#2D6A3E", border: 0, borderRadius: 20, padding: "6px 14px", fontWeight: 700, fontSize: 12, cursor: syncing ? "wait" : "pointer", opacity: syncing ? 0.6 : 1 }}>{syncing ? "Syncing…" : "Sync now"}</button>
        </div>
        {pending > 0 && <div style={{ fontSize: 11, color: "#8A6B2A", marginTop: 6, background: "#FFFBEB", border: "1px solid #FDE68A", padding: "6px 10px", borderRadius: 8 }}>Data stays on phone even if off — syncs only after you tap <b>Done for the day</b>. No half-day sends near internet.</div>}
        {msg && <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: 10, fontSize: 13, fontWeight: 500, background: msgType === "error" ? "#FDEDEC" : msgType === "success" ? "#EAF3E2" : "#FFF8E1", color: msgType === "error" ? "#922B21" : msgType === "success" ? "#1B4D3E" : "#5D4037", border: `1px solid ${msgType === "error" ? "#F5B7B1" : msgType === "success" ? "#A9DFBF" : "#FFE0B2"}` }}>{msg}</div>}
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
        <div style={{ background: "#FFFDF6", borderRadius: 16, padding: 16, boxShadow: "0 1px 6px rgba(0,0,0,0.07)", border: "1px solid #D9D2BC", marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: "#6B7D6B", fontWeight: 700 }}>Today</div>
              <input type="date" value={selectedDate} onChange={e => { setSelectedDate(e.target.value); setDayDone(!!localStorage.getItem(`done:${e.target.value}:${farmId}`)); }} style={{ marginTop: 6, padding: "10px 12px", fontSize: 16, fontWeight: 700, border: "2px solid #2D6A3E", borderRadius: 12, background: "#F2F5EA", minWidth: 160 }} />
              <div style={{ fontSize: 11, color: "#8A9A8A", marginTop: 4 }}>Auto-rolls to next day after Done — yesterday kept</div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 10, background: noPlucking ? "#FFF3E0" : "#F2F5EA", border: `2px solid ${noPlucking ? "#E3A72F" : "#C8E6C9"}`, padding: "10px 14px", borderRadius: 12, cursor: "pointer" }}>
              <input type="checkbox" checked={noPlucking} onChange={e => setNoPlucking(e.target.checked)} style={{ width: 18, height: 18, accentColor: "#E3A72F" }} />
              <span style={{ fontWeight: 700, fontSize: 13, color: noPlucking ? "#7A4A00" : "#2E7D32" }}>{noPlucking ? "✓ No plucking today" : "No plucking today"}</span>
            </label>
          </div>
          {noPlucking && (
            <div style={{ marginTop: 12 }}>
              <input placeholder="Why? e.g. heavy rain, no leaf, holiday" value={noPluckReason} onChange={e => setNoPluckReason(e.target.value)} style={{ width: "100%", padding: "12px 14px", fontSize: 15, borderRadius: 10, border: "2px solid #E3A72F", background: "#FFFBF0", boxSizing: "border-box" }} />
              <div style={{ fontSize: 12, color: "#8A6A2A", marginTop: 6 }}>Owner SMS: “No plucking {selectedDate}: {noPluckReason || "—"}”</div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#1F4D2B", fontFamily: "Georgia, 'Times New Roman', serif" }}>Today’s pick</h2>
          <span style={{ fontSize: 12, color: "#6B7D6B", background: "#FFFDF6", padding: "4px 10px", borderRadius: 20, border: "1px solid #D9D2BC" }}>{activeWorkers.length} active {dayDone ? "· ✓ Done" : ""}</span>
        </div>

        {activeWorkers.length === 0 && !noPlucking && (
          <div style={{ background: "#FFFDF6", borderRadius: 16, padding: 24, textAlign: "center", border: "2px dashed #D9D2BC" }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🌿</div><div style={{ fontWeight: 700, color: "#1F4D2B" }}>No workers yet</div><div style={{ fontSize: 13, color: "#6B7D6B", marginTop: 6 }}>Add your first picker below</div>
            <button onClick={() => { setTab("workers"); setShowAddWorker(true); }} style={{ marginTop: 14, background: "#2D6A3E", color: "white", padding: "12px 20px", borderRadius: 12, border: 0, fontWeight: 700, cursor: "pointer" }}>Add worker</button>
          </div>
        )}
        {noPlucking && activeWorkers.length > 0 && (
          <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 12, padding: 12, fontSize: 13, color: "#7A4A00", marginBottom: 12 }}>No plucking today — pickers not counted absent. Tap <b>Done for the day</b> to log.</div>
        )}

        {!noPlucking && activeWorkers.map(w => {
          const entry = daily.find(d => d.worker_id === w.worker_id && d.present);
          const kgDisplay = entry ? String(entry.kgUnits / 10) : "";
          const isAbsent = daily.some(d => d.worker_id === w.worker_id && !d.present);
          const inputId = `kg-${w.worker_id}`;
          const initials = w.full_name.split(" ").map(s => s[0]).join("").slice(0, 2).toUpperCase();
          return (
            <div key={w.worker_id} onClick={() => !isAbsent && !dayDone && document.getElementById(inputId)?.focus()} style={{ background: "#FFFDF6", borderRadius: 16, padding: 14, marginBottom: 10, display: "flex", alignItems: "center", gap: 12, border: entry ? "2px solid #2D6A3E" : "1px solid #D9D2BC", boxShadow: entry ? "0 2px 8px rgba(45,106,79,0.12)" : "0 1px 3px rgba(0,0,0,0.05)", cursor: isAbsent || dayDone ? "default" : "pointer", opacity: dayDone ? 0.85 : 1 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: entry ? "#2D6A3E" : "#EDF2E6", color: entry ? "white" : "#2D6A3E", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 14, flexShrink: 0 }}>{initials}</div>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 800, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.full_name}</div><div style={{ fontSize: 11, color: "#7A8A7A" }}>{w.phone_e164} · {entry ? `${kgDisplay} kg` : isAbsent ? "Absent" : dayDone ? "Closed" : "tap to enter"}</div></div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: isAbsent ? "#C62828" : "#8A8A8A", cursor: dayDone ? "default" : "pointer", background: isAbsent ? "#FDEDEC" : "#F5F1E3", padding: "6px 8px", borderRadius: 8, border: `1px solid ${isAbsent ? "#F5B7B1" : "#D9D2BC"}`, opacity: dayDone ? 0.6 : 1 }}>
                  <input type="checkbox" checked={isAbsent} onChange={e => setAbsent(w, e.target.checked)} disabled={dayDone} style={{ width: 14, height: 14 }} /> Absent
                </label>
                <input id={inputId} data-testid={`kg-${w.worker_id}`} inputMode="decimal" type="text" placeholder="kg" value={kgDisplay} onChange={e => setKgForWorker(w, e.target.value)} disabled={isAbsent || dayDone} style={{ width: 84, padding: "12px 10px", fontSize: 18, fontWeight: 800, textAlign: "center", border: `2px solid ${entry ? "#2D6A3E" : "#B7CBBF"}`, borderRadius: 12, background: isAbsent || dayDone ? "#F5F1E3" : entry ? "#F2F5EA" : "#FFFDF6", color: "#1F4D2B", outline: "none" }} />
                <div style={{ fontSize: 12, fontWeight: 700, color: "#2D6A3E", minWidth: 64, textAlign: "right" }}>{entry ? `KES ${Math.round(entry.kgUnits / 10 * 9)}` : ""}</div>
              </div>
            </div>
          );
        })}

        {activeWorkers.length > 0 && !noPlucking && (
          <div style={{ background: "#1F4D2B", color: "white", borderRadius: 16, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
            <div><div style={{ fontSize: 11, opacity: 0.8, letterSpacing: 0.8, textTransform: "uppercase" }}>Today total</div><div style={{ fontSize: 22, fontWeight: 900, marginTop: 2 }}>{totalKgUnits / 10} <span style={{ fontSize: 12, opacity: 0.8, fontWeight: 600 }}>kg</span> · {pickerCount} pickers</div></div>
            <div style={{ textAlign: "right" }}><div style={{ fontSize: 11, opacity: 0.8 }}>Est. pay (×9)</div><div style={{ fontSize: 18, fontWeight: 800 }}>KES {totalKes.toLocaleString()}</div></div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button data-testid="confirm-day" onClick={markDoneForDay} disabled={dayDone} style={{ flex: 1, background: dayDone ? "#EAF3E2" : "#E3A72F", color: dayDone ? "#2D6A3E" : "#23231F", padding: "16px 12px", borderRadius: 14, border: dayDone ? "2px solid #A5D6A7" : 0, fontWeight: 800, fontSize: 15, cursor: dayDone ? "default" : "pointer", boxShadow: dayDone ? "none" : "0 2px 10px rgba(227,167,47,0.45)", opacity: dayDone ? 0.9 : 1 }}>{dayDone ? "✓ Done — next day ready" : "✓ Done for the day"}</button>
          <button data-testid="submit-saturday" onClick={submitSaturday} style={{ flex: 1, background: saturday ? "white" : "#F5F1E3", color: saturday ? "#7A4A00" : "#9A9A9A", padding: "16px 12px", borderRadius: 14, border: `2px solid ${saturday ? "#E3A72F" : "#D9D2BC"}`, fontWeight: 800, fontSize: 13, cursor: saturday ? "pointer" : "not-allowed", opacity: saturday ? 1 : 0.7 }} title={saturday ? "Lock week Mon–Sat" : "Only on Saturday"}>Submit Saturday FINAL</button>
        </div>
        <div style={{ fontSize: 11, color: "#8A8A8A", textAlign: "center", marginTop: 8 }}>{dayDone ? "Data saved on phone — auto-syncs when online, no half-day sends. Phone off/on safe." : "Tap last picker’s kg, then Done — that queues full day (not half) and auto-syncs when near internet"}</div>
        {!saturday && <div style={{ fontSize: 11, color: "#9E8A5A", textAlign: "center", marginTop: 4 }}>Saturday FINAL locks weekly pay — available only on Saturday</div>}

        <div style={{ marginTop: 24, background: "#FFFDF6", borderRadius: 16, border: "1px solid #D9D2BC", overflow: "hidden" }}>
          <button onClick={() => setTab(tab === "workers" ? "daily" : "workers")} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", background: "#FFFDF6", border: 0, cursor: "pointer", textAlign: "left" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ fontSize: 18 }}>👥</span><span style={{ fontWeight: 700, fontSize: 14, color: "#1F4D2B" }}>Workers</span><span style={{ fontSize: 11, background: "#EDF2E6", color: "#2D6A3E", padding: "3px 8px", borderRadius: 20, fontWeight: 700 }}>{workers.length}</span></div>
            <span style={{ color: "#8A8A8A", fontSize: 12 }}>{tab === "workers" ? "▲ Hide" : "▼ Manage"}</span>
          </button>
          {tab === "workers" && (
            <div style={{ padding: 16, borderTop: "1px solid #F0F0EA", background: "#F5F1E3" }}>
              {!showAddWorker ? (
                <button data-testid="show-add-worker" onClick={() => setShowAddWorker(true)} style={{ width: "100%", background: "#FFFDF6", border: "2px dashed #2D6A3E", color: "#2D6A3E", padding: "14px", borderRadius: 12, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>+ Add worker</button>
              ) : (
                <div style={{ background: "#FFFDF6", borderRadius: 12, padding: 14, border: "1px solid #D9D2BC" }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: "#1F4D2B" }}>Add picker</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input data-testid="worker-name" placeholder="Name e.g. Kiptoo" value={fullName} onChange={e => setFullName(e.target.value)} style={{ flex: "1 1 140px", padding: "12px 14px", fontSize: 15, borderRadius: 10, border: "2px solid #D9D2BC" }} />
                    <input data-testid="worker-phone" placeholder="07... or +254..." value={phone} onChange={e => setPhone(e.target.value)} style={{ flex: "1 1 140px", padding: "12px 14px", fontSize: 15, borderRadius: 10, border: "2px solid #D9D2BC" }} />
                  </div>
                  <label style={{ display: "flex", gap: 8, marginTop: 12, fontSize: 12, color: "#4A5A4A", cursor: "pointer" }}>
                    <input data-testid="consent" type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} style={{ width: 18, height: 18, accentColor: "#2D6A3E" }} /><span>Worker agreed to SMS receipts & storage</span>
                  </label>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button data-testid="add-worker" onClick={registerWorker} style={{ flex: 1, background: "#2D6A3E", color: "white", padding: "13px", borderRadius: 10, border: 0, fontWeight: 800, fontSize: 15, cursor: "pointer" }}>Add worker</button>
                    <button onClick={() => { setShowAddWorker(false); setFullName(""); setPhone(""); }} style={{ padding: "13px 16px", borderRadius: 10, border: "1px solid #D9D2BC", background: "#FFFDF6", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
                  </div>
                </div>
              )}
              <div style={{ marginTop: 16 }}>
                {workers.length === 0 && <div style={{ fontSize: 13, color: "#8A8A8A", textAlign: "center", padding: 12 }}>No workers yet</div>}
                {workers.map(w => (
                  <div key={w.worker_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#FFFDF6", border: selectedWorkerId === w.worker_id ? "2px solid #2D6A3E" : "1px solid #D9D2BC", borderRadius: 12, padding: "10px 12px", marginBottom: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>{w.full_name} <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 20, background: w.status === "active" ? "#EAF3E2" : "#F5F1E3", color: w.status === "active" ? "#2E7D32" : "#8A8A8A", border: `1px solid ${w.status === "active" ? "#A5D6A7" : "#D9D2BC"}` }}>{w.status}</span></div><div style={{ fontSize: 11, color: "#7A8A7A" }}>{w.phone_e164}</div></div>
                    <button onClick={() => setSelectedWorkerId(w.worker_id === selectedWorkerId ? "" : w.worker_id)} style={{ background: selectedWorkerId === w.worker_id ? "#2D6A3E" : "white", color: selectedWorkerId === w.worker_id ? "white" : "#2D6A3E", border: "1.5px solid #2D6A3E", padding: "7px 12px", borderRadius: 20, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>{selectedWorkerId === w.worker_id ? "Selected" : "Manage"}</button>
                  </div>
                ))}
                {selectedWorkerId && (
                  <div style={{ background: "#FFFDF6", border: "1px solid #D9D2BC", borderRadius: 12, padding: 12, marginTop: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#1F4D2B" }}>{workers.find(w => w.worker_id === selectedWorkerId)?.full_name}</div>
                    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}><input type="date" value={fireDate} onChange={e => setFireDate(e.target.value)} style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #D9D2BC", fontSize: 13 }} /><input placeholder="Reason" value={fireReason} onChange={e => setFireReason(e.target.value)} style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid #D9D2BC", fontSize: 13 }} /></div>
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}><button onClick={fireWorker} style={{ flex: 1, background: "#FFF3F3", color: "#C62828", padding: "10px", borderRadius: 8, border: "1.5px solid #EF9A9A", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>End work</button><button onClick={rehireWorker} style={{ flex: 1, background: "#2D6A3E", color: "white", padding: "10px", borderRadius: 8, border: 0, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Rehire</button></div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <div style={{ textAlign: "center", marginTop: 16, paddingBottom: 20 }}><button onClick={() => { if (confirm("Clear local data?")) { localStorage.clear(); indexedDB.deleteDatabase("tea-farm-ledger"); location.reload(); } }} style={{ fontSize: 12, color: "#8A8A8A", background: "none", border: 0, textDecoration: "underline", cursor: "pointer" }}>Reset local data</button></div>
      </div>
    </div>
  );
}
