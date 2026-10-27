import { useEffect, useState, useRef } from "react";
import { db, todayEAT } from "./db.js";
import type { LocalWorker, DailyEntryLocal, OutboxEvent } from "./db.js";
import { normalizeKePhone, calculateWorkerWeekPayKes } from "@tea-ledger/core";
import {
  activeDateStorageKey,
  nextCalendarDate,
  recoverActiveDate,
  shouldAutoSyncOutbox,
} from "./dayFlow.js";

type Tab = "daily" | "workers";

function getDeviceId() {
  let id = localStorage.getItem("device_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("device_id", id);
  }
  return id;
}
function activeDateForFarm(farmId: string) {
  const today = todayEAT();
  const stored = farmId
    ? localStorage.getItem(activeDateStorageKey(farmId))
    : null;
  const date = recoverActiveDate({
    farmId,
    savedActiveDate: stored,
    today,
    isDateDone: (candidate) =>
      !!localStorage.getItem(`done:${candidate}:${farmId}`),
  });
  // Migrate both variants of the old in-memory-only auto-roll: a missing
  // pointer and a stale pointer that still names the day just marked Done.
  // A valid fresh pointer is deliberately left unchanged.
  if (
    farmId &&
    ((!stored && date !== today) || (stored !== null && date !== stored))
  ) {
    localStorage.setItem(activeDateStorageKey(farmId), date);
  }
  return date;
}
function isSaturdayEAT(d: string) {
  const date = new Date(d + "T12:00:00");
  // Get day of week in Africa/Nairobi
  const day = new Date(
    date.toLocaleString("en-US", { timeZone: "Africa/Nairobi" }),
  ).getDay();
  // Actually simpler: getUTCDay of 12:00 UTC corresponds to ~15:00 EAT same date
  // Use Intl for correct
  const nairobiDay = new Date().toLocaleDateString("en-US", {
    timeZone: "Africa/Nairobi",
    weekday: "short",
  });
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
  const [farmName, setFarmName] = useState(
    localStorage.getItem("farm_name") ?? "",
  );
  const [workers, setWorkers] = useState<LocalWorker[]>([]);
  const [selectedDate, setSelectedDate] = useState(() =>
    activeDateForFarm(farmId),
  );
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

  // Keep both scheduled and manually requested syncs to one in-flight request.
  const autoSyncTimer = useRef<number | null>(null);
  const syncingRef = useRef(false);

  function setToast(text: string, type: "info" | "error" | "success" = "info") {
    setMsg(text);
    setMsgType(type);
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
      setDayDone(
        !!localStorage.getItem(
          `done:${selectedDate}:${localStorage.getItem("farm_id")}`,
        ),
      );
    }, 900);
    return () => {
      window.removeEventListener("online", onO);
      window.removeEventListener("offline", onF);
      clearInterval(id);
    };
  }, [selectedDate, farmId]);

  // Worker/employment changes can safely sync as soon as the phone is online.
  // Kg remains local until Done queues the complete day's batch, so this never
  // sends a half-day kg entry merely because connectivity is available.
  useEffect(() => {
    if (!online || pending === 0 || syncing) return;
    let cancelled = false;
    void db.outbox.toArray().then((items) => {
      if (cancelled || !shouldAutoSyncOutbox(items)) return;
      if (autoSyncTimer.current) window.clearTimeout(autoSyncTimer.current);
      autoSyncTimer.current = window.setTimeout(() => {
        void syncNow(false);
      }, 900);
    });
    return () => {
      cancelled = true;
    };
  }, [pending, online, syncing]);

  function activateDate(date: string, targetFarmId = farmId) {
    if (targetFarmId)
      localStorage.setItem(activeDateStorageKey(targetFarmId), date);
    setSelectedDate(date);
    // Never briefly render the prior day's kg on a fresh sheet.
    setDaily([]);
    setNoPlucking(false);
    setNoPluckReason("");
    setDayDone(!!localStorage.getItem(`done:${date}:${targetFarmId}`));
  }

  function persistNextDay(date = selectedDate, targetFarmId = farmId) {
    const next = nextCalendarDate(date);
    if (targetFarmId)
      localStorage.setItem(activeDateStorageKey(targetFarmId), next);
    return next;
  }

  function startNextDay() {
    const next = persistNextDay();
    activateDate(next);
    setToast(
      `Next day ${next} — fresh sheet, yesterday kept in phone storage`,
      "info",
    );
  }

  function scheduleAutoOpenNextDay() {
    // Store the next sheet before the transition: a reload during this short
    // confirmation state still opens the blank day, never the locked one.
    const next = persistNextDay();
    window.setTimeout(() => {
      activateDate(next);
      setToast(
        `Next day ${next} — fresh sheet, yesterday kept in phone storage`,
        "info",
      );
    }, 1800);
  }

  async function saveFarmId(v: string) {
    setFarmId(v);
    localStorage.setItem("farm_id", v);
    activateDate(activeDateForFarm(v), v);
    if (v && online) {
      try {
        const res = await fetch(`/api/farms/${v}/workers`);
        if (res.ok) {
          const data = (await res.json()) as { workers: LocalWorker[] };
          for (const w of data.workers) await db.workers.put(w);
        }
      } catch {}
    }
  }
  async function createFarm() {
    if (!online) {
      setToast("Connect to internet to create farm", "error");
      return;
    }
    const name = farmName.trim();
    if (!name) {
      setToast("Enter a clear farm label, e.g. TEST-5532", "error");
      return;
    }
    try {
      const res = await fetch("/api/farms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { farm_id: string };
      saveFarmId(data.farm_id);
      localStorage.setItem("farm_name", name);
      setFarmName(name);
      setToast(`Farm "${name}" created — ready to add workers`, "success");
    } catch (e) {
      setToast(`Failed: ${String(e)}`, "error");
    }
  }

  async function registerWorker() {
    const norm = normalizeKePhone(phone);
    if (!norm.ok) {
      setToast(`Phone invalid: ${norm.reason} — use 07... or +254...`, "error");
      return;
    }
    if (!fullName.trim()) {
      setToast("Enter worker name", "error");
      return;
    }
    if (!consent) {
      setToast("Tick consent — worker agreed to SMS", "error");
      return;
    }
    if (!farmId) {
      setToast("Create or enter Farm ID first (top bar)", "error");
      return;
    }
    const dup = workers.find(
      (w) => w.phone_e164 === norm.e164 && w.status === "active",
    );
    if (dup) {
      setToast(
        `${dup.full_name} already uses ${norm.e164} — end that worker first`,
        "error",
      );
      return;
    }
    const worker_id = crypto.randomUUID();
    const worker: LocalWorker = {
      worker_id,
      farm_id: farmId,
      full_name: fullName.trim(),
      phone_e164: norm.e164,
      status: "active",
      verified: false,
      consent_at: new Date().toISOString(),
      consent_author: "supervisor",
    };
    await db.workers.put(worker);
    const device_id = getDeviceId();
    const ev = {
      event_id: crypto.randomUUID(),
      farm_id: farmId,
      device_id,
      author: "supervisor",
      event_type: "worker.registered",
      payload: {
        worker_id,
        full_name: worker.full_name,
        phone_e164: worker.phone_e164,
        consent: true,
        consent_at: worker.consent_at,
        consent_author: worker.consent_author,
      },
      business_date: selectedDate,
      client_timestamp: new Date().toISOString(),
    };
    await db.outbox.add({
      event_id: ev.event_id,
      farm_id: farmId,
      payload: ev,
      createdAt: new Date().toISOString(),
      type: "worker.registered",
    });
    const empId = crypto.randomUUID();
    await db.employment.add({
      id: empId,
      worker_id,
      farm_id: farmId,
      start_date: selectedDate,
      end_date: null,
    });
    const empEv = {
      event_id: crypto.randomUUID(),
      farm_id: farmId,
      device_id,
      author: "supervisor",
      event_type: "employment.started",
      payload: { worker_id, start_date: selectedDate },
      business_date: selectedDate,
      client_timestamp: new Date().toISOString(),
    };
    await db.outbox.add({
      event_id: empEv.event_id,
      farm_id: farmId,
      payload: empEv,
      createdAt: new Date().toISOString(),
      type: "employment.started",
    });
    setToast(
      `${worker.full_name} added — auto-syncing while online`,
      "success",
    );
    setFullName("");
    setPhone("");
    setConsent(false);
    setShowAddWorker(false);
  }
  async function fireWorker() {
    if (!selectedWorkerId) {
      setToast("Select a worker", "error");
      return;
    }
    const period = await db.employment
      .where("worker_id")
      .equals(selectedWorkerId)
      .filter((p) => p.end_date === null)
      .first();
    if (!period) {
      setToast("No active period for this worker", "error");
      return;
    }
    if (fireDate < period.start_date) {
      setToast("End date cannot be before start date", "error");
      return;
    }
    await db.employment.update(period.id, { end_date: fireDate });
    const device_id = getDeviceId();
    const ev = {
      event_id: crypto.randomUUID(),
      farm_id: farmId,
      device_id,
      author: "supervisor",
      event_type: "employment.ended",
      payload: {
        worker_id: selectedWorkerId,
        end_date: fireDate,
        reason: fireReason,
      },
      business_date: fireDate,
      client_timestamp: new Date().toISOString(),
    };
    await db.outbox.add({
      event_id: ev.event_id,
      farm_id: farmId,
      payload: ev,
      createdAt: new Date().toISOString(),
      type: "employment.ended",
    });
    await db.workers.update(selectedWorkerId, { status: "inactive" });
    setToast(
      `Closed — ${period.start_date} to ${fireDate} inclusive. History kept; auto-syncing while online.`,
      "success",
    );
    setSelectedWorkerId("");
  }
  async function rehireWorker() {
    if (!selectedWorkerId) {
      setToast("Select a worker", "error");
      return;
    }
    const periods = await db.employment
      .where("worker_id")
      .equals(selectedWorkerId)
      .toArray();
    if (periods.some((p) => p.end_date === null)) {
      setToast("Already active", "error");
      return;
    }
    const lastEnd = periods
      .filter((p) => p.end_date)
      .sort((a, b) =>
        (a.end_date as string).localeCompare(b.end_date as string),
      )
      .pop();
    if (lastEnd && selectedDate <= (lastEnd.end_date as string)) {
      setToast(`Start must be after ${lastEnd.end_date}`, "error");
      return;
    }
    const id = crypto.randomUUID();
    await db.employment.add({
      id,
      worker_id: selectedWorkerId,
      farm_id: farmId,
      start_date: selectedDate,
      end_date: null,
    });
    await db.workers.update(selectedWorkerId, { status: "active" });
    const device_id = getDeviceId();
    const ev = {
      event_id: crypto.randomUUID(),
      farm_id: farmId,
      device_id,
      author: "supervisor",
      event_type: "employment.started",
      payload: { worker_id: selectedWorkerId, start_date: selectedDate },
      business_date: selectedDate,
      client_timestamp: new Date().toISOString(),
    };
    await db.outbox.add({
      event_id: ev.event_id,
      farm_id: farmId,
      payload: ev,
      createdAt: new Date().toISOString(),
      type: "employment.started",
    });
    setToast(
      `Rehired from ${selectedDate} — history preserved; auto-syncing while online.`,
      "success",
    );
    setSelectedWorkerId("");
  }

  const activeWorkers = workers.filter((w) => w.status === "active");

  // Local-only kg (no outbox until Done) — this prevents 17 to sync half-day issue
  async function setKgForWorker(worker: LocalWorker, kgStr: string) {
    const kg = Number(kgStr);
    if (kgStr === "") {
      const existing = daily.find(
        (d) => d.worker_id === worker.worker_id && d.present,
      );
      if (existing) await db.daily.delete(existing.id);
      return;
    }
    if (isNaN(kg) || kg < 0) {
      setToast("Enter valid kg (e.g. 12.5)", "error");
      return;
    }
    if (kg > 60) {
      setToast(`Heads up: ${kg}kg unusually high (max 60)`, "info");
    }
    const kgUnits = Math.round(kg * 10);
    const id = `${selectedDate}-${worker.worker_id}`;
    const entry: DailyEntryLocal = {
      id,
      date: selectedDate,
      worker_id: worker.worker_id,
      worker_name: worker.full_name,
      kgUnits,
      present: true,
      isPluckingDay: !noPlucking,
    };
    await db.daily.put(entry);
    // Do NOT queue to outbox here — only on Done for the day
  }
  async function setAbsent(worker: LocalWorker, absent: boolean) {
    if (absent) {
      const id = `${selectedDate}-${worker.worker_id}-absent`;
      await db.daily.put({
        id,
        date: selectedDate,
        worker_id: worker.worker_id,
        worker_name: worker.full_name,
        kgUnits: 0,
        present: false,
        isPluckingDay: !noPlucking,
      });
    } else {
      const entries = daily.filter((d) => d.worker_id === worker.worker_id);
      for (const e of entries) await db.daily.delete(e.id);
    }
  }

  async function markDoneForDay() {
    if (noPlucking) {
      if (!noPluckReason.trim()) {
        setToast("Add reason: e.g. heavy rain, no leaf, holiday", "error");
        return;
      }
      const device_id = getDeviceId();
      const ev = {
        event_id: crypto.randomUUID(),
        farm_id: farmId,
        device_id,
        author: "supervisor",
        event_type: "day.plucking_set",
        payload: {
          date: selectedDate,
          is_plucking_day: false,
          reason: noPluckReason,
        },
        business_date: selectedDate,
        client_timestamp: new Date().toISOString(),
      };
      await db.outbox.add({
        event_id: ev.event_id,
        farm_id: farmId,
        payload: ev,
        createdAt: new Date().toISOString(),
        type: "day.plucking_set",
      });
      localStorage.setItem(`done:${selectedDate}:${farmId}`, "1");
      setDayDone(true);
      setToast(`No-plucking day closed — syncing complete day…`, "success");
      if (online) setTimeout(() => void syncNow(false), 600);
      // Persist before the visual transition, so reload recovery is safe.
      scheduleAutoOpenNextDay();
      return;
    }
    const present = daily.filter((d) => d.present);
    if (present.length === 0) {
      setToast("Enter at least one worker’s kg before Done", "error");
      return;
    }
    const device_id = getDeviceId();
    // Queue all plucks + absents + NP as batch (only now, not on each keystroke)
    for (const d of daily) {
      if (d.present) {
        const ev = {
          event_id: crypto.randomUUID(),
          farm_id: farmId,
          device_id,
          author: "supervisor",
          event_type: "pluck.logged",
          payload: {
            worker_id: d.worker_id,
            kg_units: d.kgUnits,
            present: true,
          },
          business_date: selectedDate,
          client_timestamp: new Date().toISOString(),
        };
        await db.outbox.add({
          event_id: ev.event_id,
          farm_id: farmId,
          payload: ev,
          createdAt: new Date().toISOString(),
          type: "pluck.logged",
        });
      } else {
        const ev = {
          event_id: crypto.randomUUID(),
          farm_id: farmId,
          device_id,
          author: "supervisor",
          event_type: "pluck.logged",
          payload: { worker_id: d.worker_id, present: false, absent: true },
          business_date: selectedDate,
          client_timestamp: new Date().toISOString(),
        };
        await db.outbox.add({
          event_id: ev.event_id,
          farm_id: farmId,
          payload: ev,
          createdAt: new Date().toISOString(),
          type: "pluck.logged",
        });
      }
    }
    const totalKgUnits = present.reduce((s, d) => s + d.kgUnits, 0);
    const pickerCount = present.length;
    const doneEv = {
      event_id: crypto.randomUUID(),
      farm_id: farmId,
      device_id,
      author: "supervisor",
      event_type: "day.confirmed",
      payload: { date: selectedDate, totalKgUnits, pickerCount },
      business_date: selectedDate,
      client_timestamp: new Date().toISOString(),
    };
    await db.outbox.add({
      event_id: doneEv.event_id,
      farm_id: farmId,
      payload: doneEv,
      createdAt: new Date().toISOString(),
      type: "day.confirmed",
    });
    localStorage.setItem(`done:${selectedDate}:${farmId}`, "1");
    setDayDone(true);
    setToast(
      `✓ Done — ${totalKgUnits / 10}kg, ${pickerCount} pickers queued. Auto-syncing…`,
      "success",
    );
    if (online) setTimeout(() => void syncNow(false), 700);
    // Persist before the visual transition, so reload recovery is safe.
    scheduleAutoOpenNextDay();
  }

  async function submitSaturday() {
    const dow = new Date(selectedDate + "T09:00:00Z").getUTCDay();
    if (dow !== 6) {
      setToast(
        `Today is not Saturday (${selectedDate}) — FINAL is only on Saturday`,
        "info",
      );
      return;
    }
    const device_id = getDeviceId();
    const ev = {
      event_id: crypto.randomUUID(),
      farm_id: farmId,
      device_id,
      author: "supervisor",
      event_type: "week.submitted",
      payload: {},
      business_date: selectedDate,
      client_timestamp: new Date().toISOString(),
    };
    await db.outbox.add({
      event_id: ev.event_id,
      farm_id: farmId,
      payload: ev,
      createdAt: new Date().toISOString(),
      type: "week.submitted",
    });
    setToast(
      `Saturday FINAL sent — week Mon–Sat locked. Late edits become next-week adjustment.`,
      "success",
    );
    if (online) setTimeout(() => syncNow(false), 600);
  }

  async function syncNow(manual = true) {
    if (syncingRef.current) return;
    // Set the ref before the first await so a timer and a button click cannot
    // start two pushes with the same outbox snapshot.
    syncingRef.current = true;
    let all: OutboxEvent[] = [];
    try {
      all = await db.outbox.toArray();
      if (!all.length) {
        if (manual) setToast("All up to date — nothing to sync", "info");
        return;
      }
      setSyncing(true);
      const events = all.map((o) => o.payload);
      const res = await fetch("/api/sync/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as {
        accepted: number;
        duplicates: number;
        flaggedAsCorrection: number;
        conflicts: number;
      };
      for (const o of all) await db.outbox.delete(o.event_id);
      localStorage.setItem("last_synced", new Date().toISOString());
      setToast(
        manual
          ? `Synced ✓ ${data.accepted} new`
          : `Auto-synced ✓ ${data.accepted} sent — data safe in cloud`,
        "success",
      );
    } catch (e) {
      const txt = String(e);
      if (txt.includes("uuid") || txt.includes("internal_error")) {
        // Clear bad outbox items (old buggy device_id "")
        // Keep only valid ones: remove items with empty device_id
        const bad = all.filter((o) => !o.payload?.device_id);
        for (const b of bad) await db.outbox.delete(b.event_id);
        if (bad.length) {
          setToast(`Cleared ${bad.length} bad pending — retry Sync`, "info");
          setSyncing(false);
          return;
        }
      }
      setToast(`Sync failed — will auto-retry. ${txt.slice(0, 140)}`, "error");
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }

  const totalKgUnits = daily
    .filter((d) => d.present)
    .reduce((s, d) => s + d.kgUnits, 0);
  const pickerCount = daily.filter((d) => d.present).length;
  const totalKes = calculateWorkerWeekPayKes(
    daily
      .filter((d) => d.present)
      .map((d) => ({ kgUnits: d.kgUnits, rateCentsPerKg: 900 })),
  );
  const saturday = isSaturdayEAT(selectedDate);

  return (
    <div className="supervisor-shell">
      <header className="supervisor-topbar">
        <div className="supervisor-topbar-inner">
          <div className="estate-brand">
            <div className="estate-crest" aria-hidden="true">
              <span>TL</span>
            </div>
            <div className="estate-brand-copy">
              <div className="estate-brand-name">Tea Ledger</div>
              <div className="estate-brand-meta">
                <span className={`connection-dot ${online ? "" : "offline"}`} />
                {farmName || "Field supervisor"} ·{" "}
                {online ? "Online" : "Offline"}
                {dayDone ? " · Day closed" : ""}
              </div>
            </div>
          </div>
          <div className="estate-farm-controls">
            <input
              value={farmName}
              onChange={(e) => setFarmName(e.target.value)}
              aria-label="Farm label"
              placeholder="Farm label, e.g. TEST-5532"
            />
            <input
              value={farmId}
              onChange={(e) => saveFarmId(e.target.value)}
              aria-label="Farm ID"
              placeholder="Farm ID"
            />
            <button
              className="estate-new-farm"
              onClick={createFarm}
              data-testid="new-farm"
            >
              + New farm
            </button>
          </div>
        </div>
      </header>

      <section className="sync-zone" aria-label="Sync status">
        <div className="sync-rail">
          <span className="sync-status">
            {pending > 0 ? (
              <>
                <span className="is-pending">● {pending} to sync</span>
                <span style={{ marginLeft: 8, opacity: 0.7 }}>
                  pending upload
                </span>
              </>
            ) : (
              <span className="is-current">✓ Up to date</span>
            )}
            {lastSynced ? (
              <span style={{ marginLeft: 10, opacity: 0.55 }}>
                · {new Date(lastSynced).toLocaleTimeString()}
              </span>
            ) : (
              ""
            )}
            {syncing ? " · syncing…" : ""}
          </span>
          <button
            className={`sync-action ${pending ? "is-pending" : ""}`}
            onClick={() => syncNow(true)}
            disabled={syncing}
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </div>
        {pending > 0 && (
          <div
            className="sync-note"
            style={{
              fontSize: 11,
              color: "#8A6B2A",
              background: "#FFFBEB",
              border: "1px solid #FDE68A",
              padding: "7px 10px",
            }}
          >
            Worker changes sync automatically while online. Kg stays on the
            phone until <b>Done for the day</b>, so no half-day kg is sent.
          </div>
        )}
        {msg && (
          <div
            className={`estate-toast estate-toast-${msgType}`}
            style={{
              marginTop: 10,
              padding: "10px 14px",
              fontSize: 13,
              fontWeight: 600,
              background:
                msgType === "error"
                  ? "#FDEDEC"
                  : msgType === "success"
                    ? "#EAF3E2"
                    : "#FFF8E1",
              color:
                msgType === "error"
                  ? "#922B21"
                  : msgType === "success"
                    ? "#1B4D3E"
                    : "#5D4037",
              border: `1px solid ${msgType === "error" ? "#F5B7B1" : msgType === "success" ? "#A9DFBF" : "#FFE0B2"}`,
            }}
          >
            {msg}
          </div>
        )}
      </section>

      <main className="supervisor-main">
        <section className="field-day-card">
          <div className="field-kicker">Estate field register</div>
          <h1 className="field-day-heading">Daily picking sheet</h1>
          <p className="field-day-subtitle">
            Capture the complete field day with confidence. The finished sheet
            stays safely locked; the next one is always ready.
          </p>
          <div className="field-day-top">
            <div>
              <div className="field-date-label">FIELD DATE</div>
              <input
                className="field-date-input"
                type="date"
                value={selectedDate}
                onChange={(e) => activateDate(e.target.value)}
              />
              <div className="field-date-help">
                Fresh next-day sheet remains available after Done
              </div>
            </div>
            <label
              className={`no-plucking-toggle ${noPlucking ? "is-active" : ""}`}
            >
              <input
                type="checkbox"
                checked={noPlucking}
                disabled={dayDone}
                onChange={(e) => setNoPlucking(e.target.checked)}
              />
              <span>
                {noPlucking ? "✓ No plucking today" : "No plucking today"}
              </span>
            </label>
          </div>
          {noPlucking && (
            <div className="no-plucking-form">
              <input
                placeholder="Why? e.g. heavy rain, no leaf, holiday"
                value={noPluckReason}
                disabled={dayDone}
                onChange={(e) => setNoPluckReason(e.target.value)}
              />
              <div className="notification-preview">
                Daily notification preview: “No plucking {selectedDate}:{" "}
                {noPluckReason || "—"}”
              </div>
              <button
                className="no-plucking-confirm"
                onClick={markDoneForDay}
                disabled={dayDone || !noPluckReason.trim()}
              >
                {dayDone
                  ? "✓ No-plucking day logged"
                  : "Confirm no-plucking day"}
              </button>
            </div>
          )}
        </section>

        <div className="pick-heading">
          <div>
            <div className="section-eyebrow">Leaf collection</div>
            <h2>Today’s pick</h2>
          </div>
          <span className="worker-count-chip">
            {activeWorkers.length} active {dayDone ? "· ✓ Done" : ""}
          </span>
        </div>

        {activeWorkers.length === 0 && !noPlucking && (
          <div className="empty-workers">
            <div className="empty-icon" aria-hidden="true">
              ✦
            </div>
            <div className="empty-title">Your field team will appear here</div>
            <div className="empty-copy">
              Add your first picker to begin today’s register.
            </div>
            <button
              onClick={() => {
                setTab("workers");
                setShowAddWorker(true);
              }}
            >
              Add worker
            </button>
          </div>
        )}
        {noPlucking && activeWorkers.length > 0 && (
          <div className="no-plucking-banner">
            No plucking today — pickers are not counted absent. Tap{" "}
            <b>Done for the day</b> to log the reason.
          </div>
        )}

        {!noPlucking &&
          activeWorkers.map((w) => {
            const entry = daily.find(
              (d) => d.worker_id === w.worker_id && d.present,
            );
            const kgDisplay = entry ? String(entry.kgUnits / 10) : "";
            const isAbsent = daily.some(
              (d) => d.worker_id === w.worker_id && !d.present,
            );
            const inputId = `kg-${w.worker_id}`;
            const initials = w.full_name
              .split(" ")
              .map((s) => s[0])
              .join("")
              .slice(0, 2)
              .toUpperCase();
            return (
              <div
                key={w.worker_id}
                onClick={() =>
                  !isAbsent &&
                  !dayDone &&
                  document.getElementById(inputId)?.focus()
                }
                className={`worker-row ${entry ? "is-entered" : ""} ${isAbsent ? "is-absent" : ""} ${dayDone ? "is-locked" : ""}`}
              >
                <div className="worker-avatar">{initials}</div>
                <div className="worker-info">
                  <div className="worker-info-name">{w.full_name}</div>
                  <div className="worker-info-meta">
                    {w.phone_e164} ·{" "}
                    {entry
                      ? `${kgDisplay} kg`
                      : isAbsent
                        ? "Absent"
                        : dayDone
                          ? "Closed"
                          : "tap to enter"}
                  </div>
                </div>
                <div
                  className="worker-inputs"
                  onClick={(e) => e.stopPropagation()}
                >
                  <label
                    className={`absent-toggle ${isAbsent ? "is-checked" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={isAbsent}
                      onChange={(e) => setAbsent(w, e.target.checked)}
                      disabled={dayDone}
                    />{" "}
                    Absent
                  </label>
                  <input
                    className="kg-input"
                    id={inputId}
                    data-testid={`kg-${w.worker_id}`}
                    inputMode="decimal"
                    type="text"
                    placeholder="kg"
                    value={kgDisplay}
                    onChange={(e) => setKgForWorker(w, e.target.value)}
                    disabled={isAbsent || dayDone}
                  />
                  <div className="worker-pay">
                    {entry ? `KES ${Math.round((entry.kgUnits / 10) * 9)}` : ""}
                  </div>
                </div>
              </div>
            );
          })}

        {activeWorkers.length > 0 && !noPlucking && (
          <section className="daily-total">
            <div>
              <div className="total-label">Today total</div>
              <div className="total-number">
                {totalKgUnits / 10} <span>kg</span> <i>·</i> {pickerCount}{" "}
                pickers
              </div>
            </div>
            <div className="total-pay">
              <div>Est. pay (×9)</div>
              <strong>KES {totalKes.toLocaleString()}</strong>
            </div>
          </section>
        )}

        <div className="daily-actions">
          <button
            className={`done-action ${dayDone ? "is-complete" : ""}`}
            data-testid="confirm-day"
            onClick={dayDone ? startNextDay : markDoneForDay}
          >
            {dayDone
              ? `Start next day → ${nextCalendarDate(selectedDate)}`
              : noPlucking
                ? "Confirm no-plucking day"
                : "✓ Done for the day"}
          </button>
          <button
            className={`final-action ${saturday ? "is-available" : ""}`}
            data-testid="submit-saturday"
            onClick={submitSaturday}
            title={saturday ? "Lock week Mon–Sat" : "Only on Saturday"}
          >
            Submit Saturday FINAL
          </button>
        </div>
        <div className="action-footnote">
          {dayDone
            ? "Completed days stay locked to protect the daily record. Start the next day for a fresh sheet."
            : "Worker changes auto-sync when online. Tap Done to queue the complete day — no half-day kg is sent."}
        </div>
        <div className="saturday-note">
          {saturday
            ? "Saturday FINAL is available for this selected date; it locks only this Mon-Sat week."
            : "Saturday FINAL is disabled only because the selected date is not Saturday. A prior lock does not disable later Saturdays."}
        </div>

        <section className="worker-manager">
          <button
            className="worker-manager-toggle"
            onClick={() => setTab(tab === "workers" ? "daily" : "workers")}
          >
            <span className="worker-manager-title">
              <span aria-hidden="true">♧</span>
              <span>Workers</span>
              <span className="worker-total">{workers.length}</span>
            </span>
            <span className="worker-manager-state">
              {tab === "workers" ? "▲ Hide" : "▼ Manage"}
            </span>
          </button>
          {tab === "workers" && (
            <div className="worker-manager-body">
              {!showAddWorker ? (
                <button
                  className="add-worker-trigger"
                  data-testid="show-add-worker"
                  onClick={() => setShowAddWorker(true)}
                >
                  + Add worker
                </button>
              ) : (
                <div className="add-worker-form">
                  <div className="form-title">Add picker</div>
                  <div className="form-row">
                    <input
                      data-testid="worker-name"
                      placeholder="Name e.g. Kiptoo"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                    />
                    <input
                      data-testid="worker-phone"
                      placeholder="07... or +254..."
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </div>
                  <label className="consent-line">
                    <input
                      data-testid="consent"
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <span>Worker agreed to SMS receipts & storage</span>
                  </label>
                  <div className="form-actions">
                    <button
                      className="add-worker-submit"
                      data-testid="add-worker"
                      onClick={registerWorker}
                    >
                      Add worker
                    </button>
                    <button
                      className="cancel-worker"
                      onClick={() => {
                        setShowAddWorker(false);
                        setFullName("");
                        setPhone("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <div className="worker-management-list">
                {workers.length === 0 && (
                  <div className="empty-management">No workers yet</div>
                )}
                {workers.map((w) => (
                  <div
                    key={w.worker_id}
                    className={`worker-management-card ${selectedWorkerId === w.worker_id ? "is-selected" : ""}`}
                  >
                    <div className="management-name">
                      <div>
                        {w.full_name}{" "}
                        <span
                          className={`employment-status ${w.status === "active" ? "active" : "inactive"}`}
                        >
                          {w.status}
                        </span>
                      </div>
                      <small>{w.phone_e164}</small>
                    </div>
                    <button
                      className="worker-select-btn"
                      onClick={() =>
                        setSelectedWorkerId(
                          w.worker_id === selectedWorkerId ? "" : w.worker_id,
                        )
                      }
                    >
                      {selectedWorkerId === w.worker_id ? "Selected" : "Manage"}
                    </button>
                  </div>
                ))}
                {selectedWorkerId && (
                  <div className="worker-management-card worker-detail-card">
                    <div className="form-title">
                      {
                        workers.find((w) => w.worker_id === selectedWorkerId)
                          ?.full_name
                      }
                    </div>
                    <div className="form-row">
                      <input
                        type="date"
                        value={fireDate}
                        onChange={(e) => setFireDate(e.target.value)}
                      />
                      <input
                        placeholder="Reason"
                        value={fireReason}
                        onChange={(e) => setFireReason(e.target.value)}
                      />
                    </div>
                    <div className="form-actions">
                      <button className="end-worker" onClick={fireWorker}>
                        End work
                      </button>
                      <button className="rehire-worker" onClick={rehireWorker}>
                        Rehire
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
        <div className="reset-local">
          <button
            className="reset-local-button"
            onClick={() => {
              if (confirm("Clear local data?")) {
                localStorage.clear();
                indexedDB.deleteDatabase("tea-farm-ledger");
                location.reload();
              }
            }}
          >
            Reset local data
          </button>
        </div>
      </main>
    </div>
  );
}
