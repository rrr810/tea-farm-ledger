import { useEffect, useState } from "react";
import { db } from "./db.js";
import type { OutboxEvent } from "./db.js";
import { normalizeKePhone } from "@tea-ledger/core";
export default function App() {
  const [pending, setPending] = useState(0);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [farmId, setFarmId] = useState(localStorage.getItem("farm_id") ?? "");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [kg, setKg] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const id = setInterval(async () => {
      const c = await db.outbox.count();
      setPending(c);
      const ls = localStorage.getItem("last_synced");
      setLastSynced(ls);
    }, 1000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      clearInterval(id);
    };
  }, []);
  async function queueWorker() {
    const norm = normalizeKePhone(phone);
    if (!norm.ok) { setMessage(`Invalid phone: ${norm.reason}`); return; }
    if (!farmId) { setMessage("Set Farm ID first (ask Admin)"); return; }
    const event_id = crypto.randomUUID();
    const ev = {
      event_id, farm_id: farmId, device_id: localStorage.getItem("device_id") ?? crypto.randomUUID(),
      author: "supervisor", event_type: "worker.registered",
      payload: { worker_id: crypto.randomUUID(), full_name: name, phone_e164: norm.e164, consent: true },
      business_date: new Date().toISOString().slice(0,10), client_timestamp: new Date().toISOString(),
    };
    await db.outbox.add({ event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString() });
    setMessage(`Queued worker ${name} — verification SMS will send when online`);
    setName(""); setPhone("");
  }
  async function queueKg() {
    if (!farmId) { setMessage("Set Farm ID first"); return; }
    const kgUnits = Math.round(Number(kg) * 10);
    if (isNaN(kgUnits) || kgUnits < 0) { setMessage("Enter kg"); return; }
    const event_id = crypto.randomUUID();
    const ev = {
      event_id, farm_id: farmId, device_id: localStorage.getItem("device_id") ?? crypto.randomUUID(),
      author: "supervisor", event_type: "pluck.logged",
      payload: { worker_id: "demo-worker", kg_units: kgUnits },
      business_date: new Date().toISOString().slice(0,10), client_timestamp: new Date().toISOString(),
    };
    await db.outbox.add({ event_id, farm_id: farmId, payload: ev, createdAt: new Date().toISOString() });
    setMessage(`Queued ${kg}kg — pending upload: ${pending+1}`);
    setKg("");
  }
  async function syncNow() {
    const all = await db.outbox.toArray();
    if (all.length === 0) { setMessage("Nothing to sync"); return; }
    try {
      const events = all.map((o: OutboxEvent) => o.payload);
      const res = await fetch("/api/sync/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }) });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { accepted: number; duplicates: number; flaggedAsCorrection: number };
      for (const o of all) await db.outbox.delete(o.event_id);
      localStorage.setItem("last_synced", new Date().toISOString());
      setLastSynced(localStorage.getItem("last_synced"));
      setMessage(`Sync ok — accepted ${data.accepted}, duplicates ${data.duplicates}, flagged ${data.flaggedAsCorrection}`);
    } catch (e) { setMessage(`Sync failed: ${String(e)}`); }
  }
  return (
    <div>
      <header><h1>Tea Ledger — Supervisor</h1><span>{online ? "Online" : "Offline"}</span></header>
      <div className="banner">DEMO DATA — {online ? "connected" : "offline, will sync when online"} · <span className="pending">Pending sync: {pending}</span> {lastSynced ? `· Last synced ${new Date(lastSynced).toLocaleString()}` : ""} {pending>0 && <em> · “pending upload” if Saturday not yet synced</em>}</div>
      <div className="card">
        <h2>Farm</h2>
        <input placeholder="Farm ID (UUID)" value={farmId} onChange={e=>{setFarmId(e.target.value); localStorage.setItem("farm_id", e.target.value)}} />
        <p style={{fontSize:14, color:"#555"}}>Ask Admin for Farm ID. PWA works offline after first load.</p>
      </div>
      <div className="card">
        <h2>1. Register worker (offline OK, verification later)</h2>
        <div className="row">
          <input placeholder="Full name" value={name} onChange={e=>setName(e.target.value)} style={{flex:1}} />
          <input placeholder="Phone 07... or +254..." value={phone} onChange={e=>setPhone(e.target.value)} style={{flex:1}} />
        </div>
        <div className="row" style={{marginTop:12}}>
          <button onClick={queueWorker}>Add worker — large button</button>
        </div>
      </div>
      <div className="card">
        <h2>2. Log kg (large buttons, sunlight-readable)</h2>
        <div className="row">
          <input inputMode="numeric" placeholder="kg, e.g. 12.5" value={kg} onChange={e=>setKg(e.target.value)} style={{flex:1}} />
          <button onClick={queueKg}>Log kg</button>
        </div>
      </div>
      <div className="card">
        <h2>3. Confirm day / Submit Saturday</h2>
        <div className="row">
          <button className="secondary">Confirm day</button>
          <button>Submit FINAL Saturday</button>
        </div>
        <p style={{fontSize:14}}>{message || "Tip: With airplane mode ON you can register, log full day and confirm — verification completes after reconnecting."}</p>
        <div className="row">
          <button onClick={syncNow} style={{background:"#FF6F00"}}>Sync now ({pending})</button>
          <button className="secondary" onClick={()=>{localStorage.clear(); indexedDB.deleteDatabase("tea-farm-ledger"); location.reload();}}>Clear demo (danger)</button>
        </div>
      </div>
      <div className="card" style={{fontSize:13, color:"#555"}}>
        <strong>No Docker/WSL needed.</strong> This preview uses same-origin <code>/api</code> proxy and ephemeral DB labeled DEMO. For pilot backup see docs. SMS mock by default.
      </div>
    </div>
  );
}
