import { useEffect, useState, useRef } from "react";
import { db, todayEAT } from "./db.js";
import type { LocalWorker, DailyEntryLocal, OutboxEvent } from "./db.js";
import {
  normalizeKePhone,
  normalizeNationalIdNumber,
  calculateWorkerWeekPayKes,
} from "@tea-ledger/core";
import {
  activeDateStorageKey,
  isSaturdayEAT,
  nextCalendarDate,
  nextOperationalDate,
  orderOutboxForSync,
  recoverActiveDate,
  saturdayFinalGate,
  saturdayFinalStorageKey,
  shouldAutoSyncOutbox,
} from "./dayFlow.js";
import { formatKgUnits, parseKgInput } from "./kgInput.js";
import {
  clearNativeSyncState,
  mirrorNativeDeviceAccess,
  mirrorNativeQueuedEvents,
  nativeHasPendingEvents,
  removeNativeQueuedEvents,
  takeNativeAcknowledgedEventIds,
} from "./nativeSync.js";

type Tab = "daily" | "workers";
type FieldDeviceLinkMode = "credentials" | "code";

type SupervisorIdentitySession = {
  token: string;
  username: string;
  farmId: string;
  expiresAt: string;
};

type LinkedFieldDevice = {
  farmId: string;
  farmName: string;
  deviceToken: string;
  supervisorSession?: SupervisorIdentitySession;
};

const SUPERVISOR_IDENTITY_SESSION_KEY = "supervisor_identity_session";
const FIELD_DEVICE_TOKEN_KEY = "field_device_access_token";

function readFieldDeviceToken(): string {
  return localStorage.getItem(FIELD_DEVICE_TOKEN_KEY)?.trim() ?? "";
}

function deviceAuthHeaders(token: string): Record<string, string> {
  return token
    ? {
        "X-Tea-Device-Id": getDeviceId(),
        "X-Tea-Device-Token": token,
      }
    : {};
}

function readSupervisorIdentitySession(): SupervisorIdentitySession | null {
  try {
    const raw = sessionStorage.getItem(SUPERVISOR_IDENTITY_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SupervisorIdentitySession;
    if (
      !parsed.token ||
      !parsed.username ||
      !parsed.farmId ||
      !parsed.expiresAt ||
      new Date(parsed.expiresAt).getTime() <= Date.now()
    ) {
      sessionStorage.removeItem(SUPERVISOR_IDENTITY_SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(SUPERVISOR_IDENTITY_SESSION_KEY);
    return null;
  }
}

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
    // A closed Saturday remains the review sheet until the server has accepted
    // that Saturday's FINAL. It must never recover to Sunday on a reload.
    canAdvancePastDate: (candidate) =>
      !isSaturdayEAT(candidate) ||
      localStorage.getItem(saturdayFinalStorageKey(farmId, candidate)) === "confirmed",
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
const ID_PHOTO_TARGET_BYTES = 900_000;
const ID_PHOTO_MAX_SOURCE_BYTES = 8_000_000;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read the ID image"));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not prepare the ID image"))),
      "image/jpeg",
      quality,
    );
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not prepare the ID image"));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const comma = value.indexOf(",");
      if (comma === -1) return reject(new Error("Could not prepare the ID image"));
      resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Keep a document photo out of the offline database and strip excess source
 * metadata by rendering a bounded JPEG only in transient browser memory.
 */
async function prepareIdPhoto(file: File): Promise<{ content_type: "image/jpeg"; base64: string }> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Use a JPEG, PNG, or WebP image for the ID photo");
  }
  if (file.size <= 0 || file.size > ID_PHOTO_MAX_SOURCE_BYTES) {
    throw new Error("Choose a clear ID image smaller than 8 MB");
  }
  const image = await loadImage(file);
  const largestSide = Math.max(image.naturalWidth, image.naturalHeight);
  for (const maxSide of [1600, 1280, 960]) {
    const scale = Math.min(1, maxSide / Math.max(1, largestSide));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This phone cannot prepare the ID image");
    context.fillStyle = "#FFFFFF";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    for (const quality of [0.82, 0.72, 0.62]) {
      const blob = await canvasToBlob(canvas, quality);
      if (blob.size <= ID_PHOTO_TARGET_BYTES) {
        return { content_type: "image/jpeg", base64: await blobToBase64(blob) };
      }
    }
  }
  throw new Error("ID image is still too large. Take a clearer, closer photo and try again.");
}

export default function App() {
  const [tab, setTab] = useState<Tab>("daily");
  const [pending, setPending] = useState(0);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [farmId, setFarmId] = useState(localStorage.getItem("farm_id") ?? "");
  // The server-stored name is canonical. It is editable only before the first
  // farm is registered on this device; a registered farm is display-only.
  const [farmName, setFarmName] = useState(
    localStorage.getItem("farm_name") ?? "",
  );
  const [registeringFarm, setRegisteringFarm] = useState(false);
  const [showNewFarmSetup, setShowNewFarmSetup] = useState(false);
  // The opaque token is issued once per enrolled field browser. It is never
  // displayed in the UI or put into the offline worker/event store.
  const [deviceToken, setDeviceToken] = useState(() => readFieldDeviceToken());
  const [enrollingDevice, setEnrollingDevice] = useState(false);
  const [workers, setWorkers] = useState<LocalWorker[]>([]);
  const [selectedDate, setSelectedDate] = useState(() =>
    activeDateForFarm(farmId),
  );
  const [noPlucking, setNoPlucking] = useState(false);
  const [noPluckReason, setNoPluckReason] = useState("");
  const [daily, setDaily] = useState<DailyEntryLocal[]>([]);
  // The raw text is kept separately from stored tenths so kg typing is
  // immediate and a picker can naturally enter a value such as `34.3`.
  const [kgDrafts, setKgDrafts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [msgType, setMsgType] = useState<"info" | "error" | "success">("info");
  const [syncing, setSyncing] = useState(false);
  const [dayDone, setDayDone] = useState(false);
  const [saturdayFinalState, setSaturdayFinalState] = useState<
    "idle" | "queued" | "confirmed"
  >("idle");

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [nationalIdNumber, setNationalIdNumber] = useState("");
  const [idPhoto, setIdPhoto] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [identityConsent, setIdentityConsent] = useState(false);
  const [registeringWorker, setRegisteringWorker] = useState(false);
  const [showAddWorker, setShowAddWorker] = useState(false);
  const [selectedWorkerId, setSelectedWorkerId] = useState("");
  const [fireDate, setFireDate] = useState(todayEAT());
  const [fireReason, setFireReason] = useState("");
  const [profileNationalIdNumber, setProfileNationalIdNumber] = useState("");
  const [profileIdPhoto, setProfileIdPhoto] = useState<File | null>(null);
  const [profileIdentityConsent, setProfileIdentityConsent] = useState(false);
  const [savingProfileIdentity, setSavingProfileIdentity] = useState(false);

  // A Supervisor session is deliberately session-only: it is never written to
  // IndexedDB/localStorage and it gates only private identity tools, not the
  // ordinary offline kg/day workflow.
  const [supervisorSession, setSupervisorSession] = useState<SupervisorIdentitySession | null>(
    () => readSupervisorIdentitySession(),
  );
  const [supervisorSessionVerified, setSupervisorSessionVerified] = useState(false);
  const [supervisorUsername, setSupervisorUsername] = useState("");
  const [supervisorPassword, setSupervisorPassword] = useState("");
  const [supervisorSigningIn, setSupervisorSigningIn] = useState(false);
  // A field-device relink is intentionally available only for an empty local
  // register. The server provides the one-time authority; the browser must
  // independently prove it has no work that could be discarded.
  const [showFieldDeviceLink, setShowFieldDeviceLink] = useState(false);
  const [fieldDeviceLinkMode, setFieldDeviceLinkMode] = useState<FieldDeviceLinkMode>("credentials");
  const [joinFarmName, setJoinFarmName] = useState("");
  const [joinSupervisorUsername, setJoinSupervisorUsername] = useState("");
  const [joinSupervisorPassword, setJoinSupervisorPassword] = useState("");
  const [fieldDeviceLinkCode, setFieldDeviceLinkCode] = useState("");
  const [linkingFieldDevice, setLinkingFieldDevice] = useState(false);

  // Keep both scheduled and manually requested syncs to one in-flight request.
  const autoSyncTimer = useRef<number | null>(null);
  const syncingRef = useRef(false);
  // Writes for the same input are serialized, so a slower earlier browser
  // storage transaction can never overwrite the most recently typed kg.
  const kgWriteQueue = useRef(new Map<string, Promise<void>>());
  const failedKgWrites = useRef(new Set<string>());

  function setToast(text: string, type: "info" | "error" | "success" = "info") {
    setMsg(text);
    setMsgType(type);
    if (text) setTimeout(() => setMsg(""), 5000);
  }

  async function queueOutbox(item: OutboxEvent, mirrorImmediately = true): Promise<void> {
    await db.outbox.add(item);
    if (mirrorImmediately) mirrorNativeQueuedEvents([item]);
  }

  function clearPrivateIdentityDrafts() {
    setNationalIdNumber("");
    setIdPhoto(null);
    setIdentityConsent(false);
    setProfileNationalIdNumber("");
    setProfileIdPhoto(null);
    setProfileIdentityConsent(false);
  }

  function clearSupervisorIdentitySession() {
    sessionStorage.removeItem(SUPERVISOR_IDENTITY_SESSION_KEY);
    setSupervisorSession(null);
    setSupervisorSessionVerified(false);
    setSupervisorPassword("");
    clearPrivateIdentityDrafts();
  }

  function rememberFieldDeviceToken(token: string) {
    localStorage.setItem(FIELD_DEVICE_TOKEN_KEY, token);
    setDeviceToken(token);
  }

  async function emptyFieldDevicePreflight(): Promise<{
    outboxCount: number;
    dailyCount: number;
    nativePending: boolean;
  }> {
    const [outboxCount, dailyCount] = await Promise.all([
      db.outbox.count(),
      db.daily.count(),
    ]);
    return { outboxCount, dailyCount, nativePending: nativeHasPendingEvents() };
  }

  function emptyDeviceLinkBlockedMessage(check: {
    outboxCount: number;
    dailyCount: number;
    nativePending: boolean;
  }): string | null {
    if (check.outboxCount > 0) {
      return "This phone has pending uploads. Sync or recover them before linking it to another farm.";
    }
    if (check.dailyCount > 0) {
      return "This phone has locally recorded daily kg. Do not link it until those records are safely recovered.";
    }
    if (check.nativePending) {
      return "This phone has pending native background sync work, or its native queue cannot be verified. Do not link it yet.";
    }
    return null;
  }

  function clearFieldFarmStorageForApprovedLink() {
    // Leave device_id in place: the server has deliberately rebound this exact
    // browser device ID and issued a fresh opaque token for it. Remove only
    // farm-scoped UI state and cache markers after an empty-device preflight.
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => Boolean(key));
    for (const key of keys) {
      if (
        key === "farm_id" ||
        key === "farm_name" ||
        key === FIELD_DEVICE_TOKEN_KEY ||
        key === "last_synced" ||
        key.startsWith("active_date:") ||
        key.startsWith("done:") ||
        key.startsWith("saturday_final:")
      ) {
        localStorage.removeItem(key);
      }
    }
  }

  async function openFieldDeviceLink() {
    if (!online) {
      setToast("Connect to the internet to join the correct farm", "error");
      return;
    }
    const blocked = emptyDeviceLinkBlockedMessage(await emptyFieldDevicePreflight());
    if (blocked) {
      setToast(blocked, "error");
      return;
    }
    setFieldDeviceLinkMode("credentials");
    setJoinFarmName("");
    setJoinSupervisorUsername("");
    setJoinSupervisorPassword("");
    setFieldDeviceLinkCode("");
    setShowFieldDeviceLink(true);
  }

  async function clearVerifiedEmptyFieldDeviceCache() {
    const blocked = emptyDeviceLinkBlockedMessage(await emptyFieldDevicePreflight());
    if (blocked) throw new Error(blocked);

    // The preflight proves there is no queued upload or local daily record.
    // Clear server-cache-only tables before making a farm-changing request so a
    // storage failure cannot consume a code or change the server binding.
    await db.transaction(
      "rw",
      db.outbox,
      db.workers,
      db.employment,
      db.daily,
      db.meta,
      async () => {
        await Promise.all([
          db.outbox.clear(),
          db.workers.clear(),
          db.employment.clear(),
          db.daily.clear(),
          db.meta.clear(),
        ]);
      },
    );
    setWorkers([]);
    setDaily([]);
    setPending(0);
  }

  function applyApprovedFieldDeviceLink(link: LinkedFieldDevice) {
    clearNativeSyncState();
    clearSupervisorIdentitySession();
    clearFieldFarmStorageForApprovedLink();

    localStorage.setItem("farm_id", link.farmId);
    localStorage.setItem("farm_name", link.farmName);
    rememberFieldDeviceToken(link.deviceToken);
    const nextDate = activeDateForFarm(link.farmId);
    setFarmId(link.farmId);
    setFarmName(link.farmName);
    setWorkers([]);
    setDaily([]);
    setPending(0);
    setLastSynced(null);
    setNoPlucking(false);
    setNoPluckReason("");
    setSaturdayFinalState("idle");
    activateDate(nextDate, link.farmId);
    if (link.supervisorSession) {
      sessionStorage.setItem(
        SUPERVISOR_IDENTITY_SESSION_KEY,
        JSON.stringify(link.supervisorSession),
      );
      setSupervisorSession(link.supervisorSession);
      setSupervisorSessionVerified(true);
    }
    setJoinFarmName("");
    setJoinSupervisorUsername("");
    setJoinSupervisorPassword("");
    setFieldDeviceLinkCode("");
    setShowFieldDeviceLink(false);
    setTab("daily");
  }

  async function linkEmptyFieldDevice() {
    const code = fieldDeviceLinkCode.trim();
    if (!code) {
      setToast("Enter the one-time code generated by the Owner/Admin", "error");
      return;
    }
    if (!online) {
      setToast("Connect to the internet to link this empty field device", "error");
      return;
    }
    setLinkingFieldDevice(true);
    try {
      await clearVerifiedEmptyFieldDeviceCache();
      const response = await fetch("/api/field-devices/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, device_id: getDeviceId() }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        farm_id?: string;
        name?: string;
        device_token?: string;
        error?: string;
      };
      if (
        !response.ok ||
        !result.ok ||
        !result.farm_id ||
        !result.name?.trim() ||
        !result.device_token
      ) {
        throw new Error(result.error || "Field device linking failed");
      }
      applyApprovedFieldDeviceLink({
        farmId: result.farm_id,
        farmName: result.name.trim(),
        deviceToken: result.device_token,
      });
      setToast("This empty field device is now linked to the approved farm.", "success");
    } catch (error) {
      setToast(String((error as Error).message), "error");
    } finally {
      setLinkingFieldDevice(false);
    }
  }

  async function joinExistingFarmWithSupervisor() {
    const officialFarmName = joinFarmName.trim();
    const username = joinSupervisorUsername.trim();
    if (!officialFarmName || !username || !joinSupervisorPassword) {
      setToast("Enter the official farm name and Supervisor credentials", "error");
      return;
    }
    if (!online) {
      setToast("Connect to the internet to join the correct farm", "error");
      return;
    }
    setLinkingFieldDevice(true);
    try {
      await clearVerifiedEmptyFieldDeviceCache();
      const response = await fetch("/api/field-devices/join-existing-farm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          farm_name: officialFarmName,
          username,
          password: joinSupervisorPassword,
          device_id: getDeviceId(),
          current_device_token: deviceToken || undefined,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        farm_id?: string;
        name?: string;
        device_token?: string;
        username?: string;
        supervisor_token?: string;
        supervisor_expires_at?: string;
        error?: string;
      };
      if (
        !response.ok ||
        !result.ok ||
        !result.farm_id ||
        !result.name?.trim() ||
        !result.device_token ||
        !result.username ||
        !result.supervisor_token ||
        !result.supervisor_expires_at
      ) {
        throw new Error(result.error || "Could not join the existing farm");
      }
      applyApprovedFieldDeviceLink({
        farmId: result.farm_id,
        farmName: result.name.trim(),
        deviceToken: result.device_token,
        supervisorSession: {
          token: result.supervisor_token,
          username: result.username,
          farmId: result.farm_id,
          expiresAt: result.supervisor_expires_at,
        },
      });
      setToast("This phone is connected to the correct farm and Supervisor tools are unlocked.", "success");
    } catch (error) {
      setToast(String((error as Error).message), "error");
    } finally {
      setLinkingFieldDevice(false);
    }
  }

  async function enrollCurrentFieldDevice(supervisorToken: string) {
    if (!farmId) throw new Error("Register the farm before securing this device");
    setEnrollingDevice(true);
    try {
      const response = await fetch(`/api/farms/${encodeURIComponent(farmId)}/devices/enroll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supervisorToken}`,
        },
        body: JSON.stringify({ device_id: getDeviceId() }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        farm_id?: string;
        device_token?: string;
        error?: string;
      };
      if (!response.ok || result.farm_id !== farmId || !result.device_token) {
        throw new Error(result.error || "Could not secure this field device");
      }
      rememberFieldDeviceToken(result.device_token);
    } finally {
      setEnrollingDevice(false);
    }
  }

  async function signInForPrivateIdentity() {
    if (!online) {
      setToast("Connect to sign in for private ID tools", "error");
      return;
    }
    if (!farmId) {
      setToast("Register the farm before Supervisor sign-in", "error");
      return;
    }
    if (!supervisorUsername.trim() || !supervisorPassword) {
      setToast("Enter your Supervisor username and password", "error");
      return;
    }
    setSupervisorSigningIn(true);
    try {
      const response = await fetch("/api/supervisor/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          farm_id: farmId,
          username: supervisorUsername,
          password: supervisorPassword,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        token?: string;
        username?: string;
        farm_id?: string;
        expires_at?: string;
        error?: string;
      };
      if (
        !response.ok ||
        !result.token ||
        !result.username ||
        result.farm_id !== farmId ||
        !result.expires_at
      ) {
        throw new Error(result.error || "Supervisor sign-in failed");
      }
      const session: SupervisorIdentitySession = {
        token: result.token,
        username: result.username,
        farmId: result.farm_id,
        expiresAt: result.expires_at,
      };
      // Existing field devices receive their opaque browser credential during
      // this authenticated one-time enrolment. New devices receive it at farm
      // registration, so neither path relies on a visible Farm ID as a secret.
      const enrolledNow = !deviceToken;
      if (enrolledNow) await enrollCurrentFieldDevice(session.token);
      sessionStorage.setItem(SUPERVISOR_IDENTITY_SESSION_KEY, JSON.stringify(session));
      setSupervisorSession(session);
      setSupervisorSessionVerified(true);
      setSupervisorPassword("");
      setToast(
        enrolledNow
          ? "This field device is secured. Private ID tools are unlocked until the session expires."
          : "Private ID tools unlocked for this farm until the session expires.",
        "success",
      );
    } catch (error) {
      setToast(String((error as Error).message), "error");
    } finally {
      setSupervisorSigningIn(false);
    }
  }

  async function signOutOfPrivateIdentity() {
    const token = supervisorSession?.token;
    clearSupervisorIdentitySession();
    if (token && online) {
      try {
        await fetch("/api/supervisor/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {}
    }
    setToast("Private ID tools locked and private drafts cleared.", "info");
  }

  const privateIdentityAccessReady =
    online &&
    supervisorSessionVerified &&
    supervisorSession?.farmId === farmId &&
    new Date(supervisorSession.expiresAt).getTime() > Date.now();

  useEffect(() => {
    if (!supervisorSession) return;
    if (!farmId || supervisorSession.farmId !== farmId) {
      clearSupervisorIdentitySession();
      return;
    }
    if (!online) {
      setSupervisorSessionVerified(false);
      clearPrivateIdentityDrafts();
      return;
    }
    let cancelled = false;
    setSupervisorSessionVerified(false);
    void fetch(`/api/supervisor/farms/${farmId}/access`, {
      headers: { Authorization: `Bearer ${supervisorSession.token}` },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("session invalid");
        const result = (await response.json()) as { expires_at?: string; username?: string };
        if (cancelled || !result.expires_at || !result.username) return;
        const next = {
          ...supervisorSession,
          username: result.username,
          expiresAt: result.expires_at,
        };
        sessionStorage.setItem(SUPERVISOR_IDENTITY_SESSION_KEY, JSON.stringify(next));
        setSupervisorSession(next);
        setSupervisorSessionVerified(true);
      })
      .catch(() => {
        if (!cancelled) clearSupervisorIdentitySession();
      });
    return () => {
      cancelled = true;
    };
  }, [farmId, online, supervisorSession?.token]);

  useEffect(() => {
    if (!supervisorSession) return;
    const msUntilExpiry = new Date(supervisorSession.expiresAt).getTime() - Date.now();
    if (msUntilExpiry <= 0) {
      clearSupervisorIdentitySession();
      return;
    }
    const timer = window.setTimeout(() => {
      clearSupervisorIdentitySession();
      setToast("Private ID session expired and private drafts were cleared.", "info");
    }, msUntilExpiry);
    return () => window.clearTimeout(timer);
  }, [supervisorSession?.token, supervisorSession?.expiresAt]);

  useEffect(() => {
    if (!online) clearPrivateIdentityDrafts();
  }, [online]);

  // A native Android shell stores only the opaque field-device credential in
  // Android Keystore-backed storage. This never mirrors a Supervisor identity
  // session or private worker identity material.
  useEffect(() => {
    if (!farmId || !deviceToken) return;
    mirrorNativeDeviceAccess({ farmId, deviceId: getDeviceId(), deviceToken });
    // Pick up an outbox that was created in the browser before this device was
    // installed as the native supervisor shell. Day entries only enter outbox
    // after Done, so this remains a completed-batch hand-off.
    void db.outbox.toArray().then((items) => {
      mirrorNativeQueuedEvents(items.filter((item) => item.farm_id === farmId));
    });
  }, [farmId, deviceToken]);

  // A native worker clears its encrypted mirror only after the server accepts
  // the batch. On the next PWA foreground run, remove exactly those matching
  // local outbox events. If this hand-off is interrupted, server event IDs make
  // the later browser retry an idempotent duplicate rather than a new SMS.
  useEffect(() => {
    if (!farmId) return;
    const acknowledged = new Set(takeNativeAcknowledgedEventIds());
    if (acknowledged.size === 0) return;
    let cancelled = false;
    void db.outbox.toArray().then(async (items) => {
      if (cancelled) return;
      for (const item of items) {
        if (item.farm_id === farmId && acknowledged.has(item.event_id)) {
          await db.outbox.delete(item.event_id);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [farmId]);

  // A field device may cache a display label from an older app version. Refresh
  // it from the narrow farm lookup when online, then keep it display-only.
  useEffect(() => {
    if (!farmId || !online || !deviceToken) return;
    let cancelled = false;
    void fetch(`/api/farms/${encodeURIComponent(farmId)}`, {
      headers: deviceAuthHeaders(deviceToken),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("farm not found");
        return (await response.json()) as { farm_id?: string; name?: string };
      })
      .then((farm) => {
        if (cancelled || farm.farm_id !== farmId || !farm.name?.trim()) return;
        const canonicalName = farm.name.trim();
        localStorage.setItem("farm_name", canonicalName);
        setFarmName(canonicalName);
      })
      // Offline work must remain usable with the last known display label.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [farmId, online, deviceToken]);

  // Refresh the local field roster only after this browser proves its farm-bound
  // device credential. Existing offline records remain usable without a network.
  useEffect(() => {
    if (!farmId || !online || !deviceToken) return;
    let cancelled = false;
    void fetch(`/api/farms/${encodeURIComponent(farmId)}/workers`, {
      headers: deviceAuthHeaders(deviceToken),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("worker roster unavailable");
        return (await response.json()) as { workers?: LocalWorker[] };
      })
      .then(async (data) => {
        if (cancelled) return;
        for (const worker of data.workers ?? []) await db.workers.put(worker);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [farmId, online, deviceToken]);

  useEffect(() => {
    // A draft belongs only to the currently open farm/day sheet.
    setKgDrafts({});
    const onO = () => setOnline(true);
    const onF = () => setOnline(false);
    window.addEventListener("online", onO);
    window.addEventListener("offline", onF);
    // Restore the closed-day and finalisation state for this farm/date. A
    // locally queued FINAL stays disabled after a reload until sync confirms it.
    const doneKey = `done:${selectedDate}:${farmId}`;
    setDayDone(!!localStorage.getItem(doneKey));
    const storedFinal = localStorage.getItem(
      saturdayFinalStorageKey(farmId, selectedDate),
    );
    setSaturdayFinalState(
      isSaturdayEAT(selectedDate) &&
        (storedFinal === "queued" || storedFinal === "confirmed")
        ? storedFinal
        : "idle",
    );
    const id = setInterval(async () => {
      const outboxItems = await db.outbox.toArray();
      setPending(outboxItems.length);
      setLastSynced(localStorage.getItem("last_synced"));
      setWorkers(await db.workers.toArray());
      setDaily(await db.daily.where("date").equals(selectedDate).toArray());
      setDayDone(
        !!localStorage.getItem(
          `done:${selectedDate}:${localStorage.getItem("farm_id")}`,
        ),
      );
      if (isSaturdayEAT(selectedDate)) {
        const queuedFinal = outboxItems.some(
          (item) =>
            item.type === "week.submitted" &&
            item.farm_id === farmId &&
            item.payload?.business_date === selectedDate,
        );
        const finalState = localStorage.getItem(
          saturdayFinalStorageKey(farmId, selectedDate),
        );
        setSaturdayFinalState(
          finalState === "confirmed"
            ? "confirmed"
            : queuedFinal || finalState === "queued"
              ? "queued"
              : "idle",
        );
      }
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
    if (!online || !deviceToken || pending === 0 || syncing) return;
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
  }, [pending, online, syncing, deviceToken]);

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

  function scheduleAutoOpenNextDay(date = selectedDate) {
    // Saturday is deliberately held for the FINAL review. It must not roll to
    // Sunday merely because the daily completion has been saved.
    if (isSaturdayEAT(date)) return;
    // Store the next sheet before the transition: a reload during this short
    // confirmation state still opens the blank day, never the locked one.
    const next = persistNextDay(date);
    window.setTimeout(() => {
      activateDate(next);
      setToast(
        `Next day ${next} — fresh sheet, yesterday kept in phone storage`,
        "info",
      );
    }, 1800);
  }

  async function adoptRegisteredFarm(farm: {
    farm_id: string;
    name: string;
    device_token?: string;
  }) {
    if (farm.farm_id !== farmId) clearSupervisorIdentitySession();
    const nextDeviceToken = farm.device_token ?? deviceToken;
    if (farm.device_token) rememberFieldDeviceToken(farm.device_token);
    setFarmId(farm.farm_id);
    setFarmName(farm.name);
    localStorage.setItem("farm_id", farm.farm_id);
    localStorage.setItem("farm_name", farm.name);
    activateDate(activeDateForFarm(farm.farm_id), farm.farm_id);
    if (online && nextDeviceToken) {
      try {
        const res = await fetch(`/api/farms/${encodeURIComponent(farm.farm_id)}/workers`, {
          headers: deviceAuthHeaders(nextDeviceToken),
        });
        if (res.ok) {
          const data = (await res.json()) as { workers: LocalWorker[] };
          for (const worker of data.workers) await db.workers.put(worker);
        }
      } catch {}
    }
  }

  async function createFarm() {
    if (!online) {
      setToast("Connect to the internet to register the farm", "error");
      return;
    }
    // Once farm_id exists, this device renders a locked server-backed identity
    // rather than offering another creation or editing path.
    if (farmId) return;
    const name = farmName.trim();
    if (!name) {
      setToast("Enter the official farm name before registering it", "error");
      return;
    }
    setRegisteringFarm(true);
    try {
      const res = await fetch("/api/farms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, device_id: getDeviceId() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        farm_id?: string;
        name?: string;
        device_token?: string;
        error?: string;
      };
      if (!res.ok || !data.farm_id || !data.name || !data.device_token) {
        throw new Error(data.error || "Farm registration failed");
      }
      await adoptRegisteredFarm({
        farm_id: data.farm_id,
        name: data.name,
        device_token: data.device_token,
      });
      setToast(`Farm "${data.name}" registered and locked on this device.`, "success");
    } catch (error) {
      setToast(String((error as Error).message), "error");
    } finally {
      setRegisteringFarm(false);
    }
  }

  async function queueOfflineBasicWorker(norm: { e164: string }) {
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
    const registration = {
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
    const employment = {
      event_id: crypto.randomUUID(),
      farm_id: farmId,
      device_id,
      author: "supervisor",
      event_type: "employment.started",
      payload: { worker_id, start_date: selectedDate },
      business_date: selectedDate,
      client_timestamp: new Date().toISOString(),
    };
    await queueOutbox({
      event_id: registration.event_id,
      farm_id: farmId,
      payload: registration,
      createdAt: new Date().toISOString(),
      type: "worker.registered",
    });
    await db.employment.add({
      id: crypto.randomUUID(),
      worker_id,
      farm_id: farmId,
      start_date: selectedDate,
      end_date: null,
    });
    await queueOutbox({
      event_id: employment.event_id,
      farm_id: farmId,
      payload: employment,
      createdAt: new Date().toISOString(),
      type: "employment.started",
    });
    setToast(
      `${worker.full_name} saved as a basic worker — complete private ID details online later.`,
      "success",
    );
    setFullName("");
    setPhone("");
    setNationalIdNumber("");
    setIdPhoto(null);
    setConsent(false);
    setIdentityConsent(false);
    setShowAddWorker(false);
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
      setToast("Tick SMS consent before adding the worker", "error");
      return;
    }
    if (!farmId) {
      setToast("Register the farm first in the top bar", "error");
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
    if (!privateIdentityAccessReady || !deviceToken) {
      const reason = online
        ? deviceToken
          ? "Private ID details need a Supervisor sign-in for this farm."
          : "Secure this field device with a Supervisor sign-in before saving private ID details."
        : "Private ID details cannot be saved offline and will not be queued on this phone.";
      const saveBasicOnly = window.confirm(
        `${reason} Add this worker with name and phone only, then complete the ID profile online after Supervisor sign-in?`,
      );
      if (saveBasicOnly) await queueOfflineBasicWorker(norm);
      return;
    }
    const nationalId = normalizeNationalIdNumber(nationalIdNumber);
    if (!nationalId.ok) {
      setToast(nationalId.reason, "error");
      return;
    }
    if (!identityConsent) {
      setToast("Tick identity-information consent before adding the worker", "error");
      return;
    }

    setRegisteringWorker(true);
    try {
      const preparedPhoto = idPhoto ? await prepareIdPhoto(idPhoto) : undefined;
      const response = await fetch(`/api/farms/${farmId}/workers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supervisorSession!.token}`,
          ...deviceAuthHeaders(deviceToken),
        },
        body: JSON.stringify({
          full_name: fullName.trim(),
          phone: norm.e164,
          consent: true,
          national_id_number: nationalId.value,
          identity_consent: true,
          id_photo: preparedPhoto,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        worker_id?: string;
        phone_e164?: string;
        id_photo_recorded?: boolean;
        error?: string;
      };
      if (response.status === 401 || response.status === 403) {
        clearSupervisorIdentitySession();
      }
      if (!response.ok || !result.worker_id || !result.phone_e164) {
        throw new Error(result.error || "Could not add the worker");
      }

      const worker: LocalWorker = {
        worker_id: result.worker_id,
        farm_id: farmId,
        full_name: fullName.trim(),
        phone_e164: result.phone_e164,
        status: "active",
        verified: false,
        consent_at: new Date().toISOString(),
        consent_author: "supervisor",
      };
      await db.workers.put(worker);
      await db.employment.put({
        id: crypto.randomUUID(),
        worker_id: worker.worker_id,
        farm_id: farmId,
        start_date: todayEAT(),
        end_date: null,
      });
      setToast(
        `${worker.full_name} added securely${result.id_photo_recorded ? " with ID photo" : ""}.`,
        "success",
      );
      setFullName("");
      setPhone("");
      setNationalIdNumber("");
      setIdPhoto(null);
      setConsent(false);
      setIdentityConsent(false);
      setShowAddWorker(false);
    } catch (error) {
      setToast(String((error as Error).message), "error");
    } finally {
      setRegisteringWorker(false);
    }
  }
  async function completeWorkerIdentity() {
    if (!selectedWorkerId) {
      setToast("Select a worker first", "error");
      return;
    }
    if (!privateIdentityAccessReady || !deviceToken) {
      setToast(
        online
          ? deviceToken
            ? "Sign in as this farm's Supervisor before completing private ID details."
            : "Secure this field device with a Supervisor sign-in before completing private ID details."
          : "Connect to complete private ID details. They are never queued offline.",
        "error",
      );
      return;
    }
    const nationalId = normalizeNationalIdNumber(profileNationalIdNumber);
    if (!nationalId.ok) {
      setToast(nationalId.reason, "error");
      return;
    }
    if (!profileIdentityConsent) {
      setToast("Tick identity-information consent before saving", "error");
      return;
    }
    setSavingProfileIdentity(true);
    try {
      const preparedPhoto = profileIdPhoto
        ? await prepareIdPhoto(profileIdPhoto)
        : undefined;
      const response = await fetch(
        `/api/farms/${farmId}/workers/${selectedWorkerId}/identity`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supervisorSession!.token}`,
            ...deviceAuthHeaders(deviceToken),
          },
          body: JSON.stringify({
            national_id_number: nationalId.value,
            identity_consent: true,
            id_photo: preparedPhoto,
          }),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        id_photo_recorded?: boolean;
        error?: string;
      };
      if (response.status === 401 || response.status === 403) {
        clearSupervisorIdentitySession();
      }
      if (!response.ok) {
        throw new Error(result.error || "Could not save the private ID profile");
      }
      setToast(
        `Private ID profile saved${result.id_photo_recorded ? " with ID photo" : ""}.`,
        "success",
      );
      setProfileNationalIdNumber("");
      setProfileIdPhoto(null);
      setProfileIdentityConsent(false);
    } catch (error) {
      setToast(String((error as Error).message), "error");
    } finally {
      setSavingProfileIdentity(false);
    }
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
    await queueOutbox({
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
    await queueOutbox({
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

  function upsertDailyEntry(entry: DailyEntryLocal) {
    setDaily((current) => {
      const index = current.findIndex((item) => item.id === entry.id);
      if (index === -1) return [...current, entry];
      return current.map((item) => (item.id === entry.id ? entry : item));
    });
  }

  function removeDailyEntry(id: string) {
    setDaily((current) => current.filter((entry) => entry.id !== id));
  }

  function queueKgWrite(key: string, write: () => Promise<void>) {
    // A new explicit entry is a retry for this picker, so it replaces any
    // earlier local-storage error for the same day/worker key.
    failedKgWrites.current.delete(key);
    const previous = kgWriteQueue.current.get(key) ?? Promise.resolve();
    const next = previous.then(write, write);
    kgWriteQueue.current.set(key, next);
    void next.then(
      () => {
        if (kgWriteQueue.current.get(key) === next) {
          kgWriteQueue.current.delete(key);
        }
      },
      () => {
        if (kgWriteQueue.current.get(key) === next) {
          kgWriteQueue.current.delete(key);
        }
        failedKgWrites.current.add(key);
        setToast(
          "Couldn't save kg on this phone. Keep this screen open and try again.",
          "error",
        );
      },
    );
    return next;
  }

  async function flushKgWrites() {
    const currentDayPrefix = `${selectedDate}-`;
    const currentDayWrites = [...kgWriteQueue.current.entries()]
      .filter(([key]) => key.startsWith(currentDayPrefix))
      .map(([, write]) => write);
    await Promise.all(currentDayWrites);
    if (
      [...failedKgWrites.current].some((key) =>
        key.startsWith(currentDayPrefix),
      )
    ) {
      throw new Error("kg write failed");
    }
  }

  // Local-only kg (no outbox until Done). The visible value updates before
  // IndexedDB writes, so field entry stays instant even on a slower phone.
  function setKgForWorker(worker: LocalWorker, rawValue: string) {
    const parsed = parseKgInput(rawValue);
    if (parsed.kind === "invalid") {
      setToast(parsed.message, "error");
      return;
    }

    setKgDrafts((current) => ({
      ...current,
      [worker.worker_id]: parsed.text,
    }));

    const id = `${selectedDate}-${worker.worker_id}`;
    if (parsed.kind === "empty") {
      removeDailyEntry(id);
      void queueKgWrite(id, () => db.daily.delete(id));
      return;
    }
    if (parsed.kind === "incomplete") return;

    const entry: DailyEntryLocal = {
      id,
      date: selectedDate,
      worker_id: worker.worker_id,
      worker_name: worker.full_name,
      kgUnits: parsed.kgUnits,
      present: true,
      isPluckingDay: !noPlucking,
    };
    upsertDailyEntry(entry);
    void queueKgWrite(id, () => db.daily.put(entry));

    if (parsed.kgUnits > 600) {
      setToast(
        `Heads up: ${formatKgUnits(parsed.kgUnits)}kg unusually high (max 60)`,
        "info",
      );
    }
  }

  function normalizeKgDraft(worker: LocalWorker) {
    const draft = kgDrafts[worker.worker_id];
    if (draft === undefined) return;
    const parsed = parseKgInput(draft);
    if (parsed.kind === "valid") {
      setKgDrafts((current) => ({
        ...current,
        [worker.worker_id]: formatKgUnits(parsed.kgUnits),
      }));
      return;
    }
    if (parsed.kind === "empty") return;

    setKgDrafts((current) => {
      const next = { ...current };
      delete next[worker.worker_id];
      return next;
    });
    setToast("Use whole kg or one decimal, e.g. 34.3", "error");
  }
  async function setAbsent(worker: LocalWorker, absent: boolean) {
    const kgId = `${selectedDate}-${worker.worker_id}`;
    const absentId = `${kgId}-absent`;
    setKgDrafts((current) => {
      const next = { ...current };
      delete next[worker.worker_id];
      return next;
    });

    const removeCurrentWorkerEntries = async () => {
      const entries = await db.daily
        .where("date")
        .equals(selectedDate)
        .filter((entry) => entry.worker_id === worker.worker_id)
        .toArray();
      await Promise.all(entries.map((entry) => db.daily.delete(entry.id)));
    };

    if (absent) {
      const absence: DailyEntryLocal = {
        id: absentId,
        date: selectedDate,
        worker_id: worker.worker_id,
        worker_name: worker.full_name,
        kgUnits: 0,
        present: false,
        isPluckingDay: !noPlucking,
      };
      setDaily((current) => [
        ...current.filter(
          (entry) =>
            entry.date !== selectedDate || entry.worker_id !== worker.worker_id,
        ),
        absence,
      ]);
      try {
        // Share the kg write queue: a fast absent tap cannot be overwritten by
        // an earlier in-flight kg write for the same picker.
        await queueKgWrite(kgId, async () => {
          await removeCurrentWorkerEntries();
          await db.daily.put(absence);
        });
      } catch {
        // queueKgWrite already exposes the local storage failure to the user.
      }
      return;
    }

    setDaily((current) =>
      current.filter(
        (entry) =>
          entry.date !== selectedDate || entry.worker_id !== worker.worker_id,
      ),
    );
    try {
      await queueKgWrite(kgId, removeCurrentWorkerEntries);
    } catch {
      // queueKgWrite already exposes the local storage failure to the user.
    }
  }

  async function markDoneForDay() {
    try {
      await flushKgWrites();
    } catch {
      setToast("Could not save the latest kg. Keep this screen open and try again.", "error");
      return;
    }
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
      const noPluckingOutbox: OutboxEvent = {
        event_id: ev.event_id,
        farm_id: farmId,
        payload: ev,
        createdAt: new Date().toISOString(),
        type: "day.plucking_set",
      };
      await queueOutbox(noPluckingOutbox, false);
      // The native foreground worker sees a completed no-plucking day only
      // after the PWA has made its durable local write.
      mirrorNativeQueuedEvents([noPluckingOutbox]);
      localStorage.setItem(`done:${selectedDate}:${farmId}`, "1");
      setDayDone(true);
      setToast(`No-plucking day closed — syncing complete day…`, "success");
      if (online) setTimeout(() => void syncNow(false), 600);
      // Saturday remains open for register review and FINAL; other days roll
      // to their fresh sheet after the normal confirmation pause.
      scheduleAutoOpenNextDay(selectedDate);
      return;
    }
    const present = daily.filter((d) => d.present);
    if (present.length === 0) {
      setToast("Enter at least one worker’s kg before Done", "error");
      return;
    }
    const device_id = getDeviceId();
    // Queue all plucks + absents + NP as batch (only now, not on each keystroke).
    // Do not expose individual kg to the native foreground worker until the
    // matching day.confirmed record has been safely written as well.
    const nativeDayBatch: OutboxEvent[] = [];
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
        const outboxEvent: OutboxEvent = {
          event_id: ev.event_id,
          farm_id: farmId,
          payload: ev,
          createdAt: new Date().toISOString(),
          type: "pluck.logged",
        };
        await queueOutbox(outboxEvent, false);
        nativeDayBatch.push(outboxEvent);
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
        const outboxEvent: OutboxEvent = {
          event_id: ev.event_id,
          farm_id: farmId,
          payload: ev,
          createdAt: new Date().toISOString(),
          type: "pluck.logged",
        };
        await queueOutbox(outboxEvent, false);
        nativeDayBatch.push(outboxEvent);
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
    const doneOutbox: OutboxEvent = {
      event_id: doneEv.event_id,
      farm_id: farmId,
      payload: doneEv,
      createdAt: new Date().toISOString(),
      type: "day.confirmed",
    };
    await queueOutbox(doneOutbox, false);
    nativeDayBatch.push(doneOutbox);
    // The bridge now receives the all-or-nothing completion batch, never any
    // individual kg event while the supervisor is still entering the day.
    mirrorNativeQueuedEvents(nativeDayBatch);
    localStorage.setItem(`done:${selectedDate}:${farmId}`, "1");
    setDayDone(true);
    setToast(
      `✓ Done — ${totalKgUnits / 10}kg, ${pickerCount} pickers queued. Auto-syncing…`,
      "success",
    );
    if (online) setTimeout(() => void syncNow(false), 700);
    // Saturday remains open for register review and FINAL; other days roll
    // to their fresh sheet after the normal confirmation pause.
    scheduleAutoOpenNextDay(selectedDate);
  }

  function confirmSaturdayFinalisation(date: string, targetFarmId = farmId) {
    localStorage.setItem(saturdayFinalStorageKey(targetFarmId, date), "confirmed");
    if (targetFarmId !== farmId || selectedDate !== date) return;
    setSaturdayFinalState("confirmed");
    const monday = nextOperationalDate(date);
    activateDate(monday, targetFarmId);
    setToast(
      `Saturday FINAL confirmed — Mon–Sat is locked. Monday ${monday} is ready for a fresh sheet.`,
      "success",
    );
  }

  async function submitSaturday() {
    const gate = saturdayFinalGate({
      date: selectedDate,
      dayDone,
      submissionState: saturdayFinalState,
    });
    if (gate === "not-saturday") {
      setToast(
        `Today is not Saturday (${selectedDate}) — FINAL is only on Saturday`,
        "info",
      );
      return;
    }
    if (gate === "saturday-not-done") {
      setToast("Complete Saturday with Done before submitting FINAL.", "error");
      return;
    }
    if (gate === "queued") {
      setToast("Saturday FINAL is already queued. Connect and sync to confirm the lock.", "info");
      return;
    }
    if (gate === "confirmed") {
      setToast("This Saturday FINAL was already confirmed. Monday is the next fresh sheet.", "info");
      return;
    }

    // Protect upgraded devices that may already have a historical FINAL queued
    // before this version stored the local finalisation marker.
    const alreadyQueued = (await db.outbox.toArray()).some(
      (item) =>
        item.type === "week.submitted" &&
        item.farm_id === farmId &&
        item.payload?.business_date === selectedDate,
    );
    if (alreadyQueued) {
      localStorage.setItem(saturdayFinalStorageKey(farmId, selectedDate), "queued");
      setSaturdayFinalState("queued");
      setToast("Saturday FINAL is already queued. Connect and sync to confirm the lock.", "info");
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
    await queueOutbox({
      event_id: ev.event_id,
      farm_id: farmId,
      payload: ev,
      createdAt: new Date().toISOString(),
      type: "week.submitted",
    });
    localStorage.setItem(saturdayFinalStorageKey(farmId, selectedDate), "queued");
    setSaturdayFinalState("queued");
    setToast(
      "Saturday FINAL queued. It will lock Mon–Sat only after Saturday Done and a successful sync.",
      "info",
    );
    if (online) setTimeout(() => void syncNow(false), 150);
  }

  async function syncNow(manual = true) {
    if (syncingRef.current) return;
    // Set the ref before the first await so a timer and a button click cannot
    // start two pushes with the same outbox snapshot.
    syncingRef.current = true;
    let all: OutboxEvent[] = [];
    try {
      if (!deviceToken) {
        if (manual) {
          setToast("Secure this field device with a Supervisor sign-in before syncing.", "error");
        }
        return;
      }
      all = await db.outbox.toArray();
      if (!all.length) {
        if (manual) setToast("All up to date — nothing to sync", "info");
        return;
      }
      setSyncing(true);
      // Random UUID primary keys do not preserve insertion order in Dexie. FINAL
      // is deliberately last so the server sees Saturday's completed-day batch
      // before evaluating the irreversible week lock.
      all = orderOutboxForSync(all);
      const events = all.map((o) => o.payload);
      const res = await fetch("/api/sync/push", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...deviceAuthHeaders(deviceToken) },
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
      // The browser and native worker share event IDs. Once this authenticated
      // browser push succeeds, remove the native mirror too so a later network
      // callback cannot submit a second copy (the server would still dedupe it).
      removeNativeQueuedEvents(all.map((item) => item.event_id));
      localStorage.setItem("last_synced", new Date().toISOString());
      setToast(
        manual
          ? `Synced ✓ ${data.accepted} new`
          : `Auto-synced ✓ ${data.accepted} sent — data safe in cloud`,
        "success",
      );
      // A successful response means each queued FINAL was newly accepted or was
      // already present as an idempotent retry. Only now may the device leave
      // Saturday and open the next Monday sheet.
      for (const item of all) {
        if (
          item.type === "week.submitted" &&
          typeof item.payload?.business_date === "string" &&
          isSaturdayEAT(item.payload.business_date)
        ) {
          confirmSaturdayFinalisation(item.payload.business_date, item.farm_id);
        }
      }
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
  const finalGate = saturdayFinalGate({
    date: selectedDate,
    dayDone,
    submissionState: saturdayFinalState,
  });
  const finalEnabled = finalGate === "ready";

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
          {farmId ? (
            <>
              <div className="estate-farm-locked" aria-label="Registered farm locked on this device">
                <strong>{farmName || "Registered farm"}</strong>
                <span>
                  Farm {farmId.slice(0, 8)} · Locked · {deviceToken ? "Device secure" : "Secure device"}
                </span>
              </div>
              <button
                type="button"
                data-testid="link-empty-field-device"
                onClick={() => void openFieldDeviceLink()}
                disabled={linkingFieldDevice || supervisorSigningIn || enrollingDevice}
                style={{
                  border: "1px solid #D9D1BC",
                  borderRadius: 8,
                  background: "#FFFDF7",
                  color: "#5D4933",
                  fontSize: 11,
                  padding: "6px 8px",
                  cursor: "pointer",
                }}
                title="Use only when this device has no pending or local daily records"
              >
                Join correct farm
              </button>
            </>
          ) : (
            <div className="estate-farm-registration" aria-label="Existing or new farm setup">
              <div style={{ display: "grid", gap: 5 }}>
                <strong style={{ fontSize: 12 }}>Already have a farm?</strong>
                <span style={{ fontSize: 11, color: "#4A4A42" }}>
                  Supervisor sign-in connects this phone to the existing farm.
                </span>
              </div>
              <button
                type="button"
                data-testid="link-existing-field-farm"
                onClick={() => void openFieldDeviceLink()}
                disabled={registeringFarm || linkingFieldDevice}
                style={{
                  border: "1px solid #D9D1BC",
                  borderRadius: 8,
                  background: "#FFFDF7",
                  color: "#5D4933",
                  fontSize: 11,
                  padding: "6px 8px",
                  cursor: "pointer",
                }}
              >
                Join existing farm
              </button>
              {!showNewFarmSetup ? (
                <button
                  type="button"
                  onClick={() => setShowNewFarmSetup(true)}
                  disabled={linkingFieldDevice}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "#6B6B5E",
                    fontSize: 11,
                    padding: "4px 0",
                    textDecoration: "underline",
                    cursor: "pointer",
                  }}
                >
                  Owner only: set up a brand-new farm
                </button>
              ) : (
                <>
                  <label>
                    <span>New farm — one-time Owner setup</span>
                    <input
                      value={farmName}
                      onChange={(e) => setFarmName(e.target.value)}
                      aria-label="Official farm name"
                      placeholder="Official farm name"
                      maxLength={80}
                      disabled={registeringFarm}
                    />
                  </label>
                  <button
                    className="estate-new-farm"
                    onClick={() => void createFarm()}
                    disabled={registeringFarm}
                    data-testid="register-farm"
                  >
                    {registeringFarm ? "Registering…" : "Register & lock new farm"}
                  </button>
                  <button
                    type="button"
                    disabled={registeringFarm}
                    onClick={() => {
                      setShowNewFarmSetup(false);
                      setFarmName("");
                    }}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "#6B6B5E",
                      fontSize: 11,
                      padding: "2px 0",
                      textDecoration: "underline",
                      cursor: "pointer",
                    }}
                  >
                    Cancel new-farm setup
                  </button>
                </>
              )}
            </div>
          )}
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

      {showFieldDeviceLink && (
        <section
          className="sync-zone"
          aria-live="polite"
          style={{ borderColor: "#D8E2D3", background: "#F7FBF4" }}
        >
          <div style={{ display: "grid", gap: 9 }}>
            <div>
              <b>
                {fieldDeviceLinkMode === "credentials"
                  ? "Join your existing farm"
                  : "Use an Owner one-time code"}
              </b>
              <p style={{ margin: "5px 0 0", fontSize: 12, lineHeight: 1.45, color: "#4A4A42" }}>
                {fieldDeviceLinkMode === "credentials"
                  ? "Enter the official farm name and the Supervisor account created by the Owner/Admin. The farm name finds the farm; the Supervisor password proves access."
                  : "Enter the short-lived code generated in the Owner/Admin console. Use this if the farm name is not unique or the Owner prefers to approve this phone directly."}
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="sync-action"
                disabled={linkingFieldDevice}
                onClick={() => setFieldDeviceLinkMode("credentials")}
                style={{ opacity: fieldDeviceLinkMode === "credentials" ? 1 : 0.68 }}
              >
                Farm + Supervisor sign-in
              </button>
              <button
                type="button"
                className="sync-action"
                disabled={linkingFieldDevice}
                onClick={() => setFieldDeviceLinkMode("code")}
                style={{ opacity: fieldDeviceLinkMode === "code" ? 1 : 0.68 }}
              >
                Owner code instead
              </button>
            </div>

            {fieldDeviceLinkMode === "credentials" ? (
              <>
                <input
                  aria-label="Official farm name"
                  autoCapitalize="words"
                  autoCorrect="off"
                  placeholder="Official farm name"
                  value={joinFarmName}
                  disabled={linkingFieldDevice}
                  onChange={(event) => setJoinFarmName(event.target.value)}
                  style={{ minHeight: 40 }}
                />
                <input
                  aria-label="Supervisor username for existing farm"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="username"
                  placeholder="Supervisor username"
                  value={joinSupervisorUsername}
                  disabled={linkingFieldDevice}
                  onChange={(event) => setJoinSupervisorUsername(event.target.value)}
                  style={{ minHeight: 40 }}
                />
                <input
                  type="password"
                  aria-label="Supervisor password for existing farm"
                  autoComplete="current-password"
                  placeholder="Supervisor password"
                  value={joinSupervisorPassword}
                  disabled={linkingFieldDevice}
                  onChange={(event) => setJoinSupervisorPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void joinExistingFarmWithSupervisor();
                  }}
                  style={{ minHeight: 40 }}
                />
                <button
                  className="sync-action"
                  disabled={
                    linkingFieldDevice ||
                    !joinFarmName.trim() ||
                    !joinSupervisorUsername.trim() ||
                    !joinSupervisorPassword
                  }
                  onClick={() => void joinExistingFarmWithSupervisor()}
                >
                  {linkingFieldDevice ? "Connecting…" : "Sign in & connect this phone"}
                </button>
              </>
            ) : (
              <>
                <input
                  aria-label="One-time field-device link code"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="one-time-code"
                  placeholder="One-time link code"
                  value={fieldDeviceLinkCode}
                  disabled={linkingFieldDevice}
                  onChange={(event) => setFieldDeviceLinkCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void linkEmptyFieldDevice();
                  }}
                  style={{ minHeight: 40, fontFamily: "monospace" }}
                />
                <button
                  className="sync-action"
                  disabled={linkingFieldDevice || !fieldDeviceLinkCode.trim()}
                  onClick={() => void linkEmptyFieldDevice()}
                >
                  {linkingFieldDevice ? "Linking…" : "Link approved empty device"}
                </button>
              </>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="sync-action"
                disabled={linkingFieldDevice}
                onClick={() => {
                  setShowFieldDeviceLink(false);
                  setJoinFarmName("");
                  setJoinSupervisorUsername("");
                  setJoinSupervisorPassword("");
                  setFieldDeviceLinkCode("");
                }}
              >
                Cancel
              </button>
            </div>
            <small style={{ color: "#6B6B5E", lineHeight: 1.4 }}>
              Continue only when this phone has no pending sync or local daily records. Joining
              clears this phone&apos;s cache and never moves people, kg, payroll, or messages between farms.
            </small>
          </div>
        </section>
      )}

      {farmId && !deviceToken && (
        <section
          className="sync-zone"
          aria-live="polite"
          style={{ borderColor: "#F4C66A", background: "#FFF9ED" }}
        >
          <div className="sync-rail" style={{ gap: 12, alignItems: "center" }}>
            <span className="sync-status" style={{ color: "#76521A" }}>
              <b>Secure this field device</b> · One Supervisor sign-in is required before this phone can download or sync farm records.
            </span>
            <button
              className="sync-action is-pending"
              onClick={() => setTab("workers")}
              disabled={!online || enrollingDevice}
            >
              {enrollingDevice ? "Securing…" : "Secure device"}
            </button>
          </div>
        </section>
      )}

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
            const kgDisplay = entry ? formatKgUnits(entry.kgUnits) : "";
            const kgInputValue = kgDrafts[w.worker_id] ?? kgDisplay;
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
                    value={kgInputValue}
                    onChange={(e) => setKgForWorker(w, e.target.value)}
                    onBlur={() => normalizeKgDraft(w)}
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
          {/* Saturday stays visible for register review. FINAL, not this
              control, opens the fresh Monday sheet after cloud confirmation. */}
          <button
            className={`done-action ${dayDone ? "is-complete" : ""}`}
            data-testid="confirm-day"
            onClick={dayDone ? startNextDay : markDoneForDay}
            disabled={dayDone && saturday}
            title={
              dayDone && saturday
                ? "Review Saturday, then submit FINAL"
                : undefined
            }
          >
            {dayDone
              ? saturday
                ? finalGate === "confirmed"
                  ? "Saturday FINAL confirmed"
                  : "Saturday complete — review then FINAL"
                : `Start next day → ${nextCalendarDate(selectedDate)}`
              : noPlucking
                ? "Confirm no-plucking day"
                : "✓ Done for the day"}
          </button>
          <button
            className={`final-action ${finalEnabled ? "is-available" : ""} ${
              finalGate === "queued" ? "is-pending" : ""
            }`}
            data-testid="submit-saturday"
            onClick={submitSaturday}
            disabled={!finalEnabled}
            title={
              finalGate === "not-saturday"
                ? "Available only on Saturday"
                : finalGate === "saturday-not-done"
                  ? "Complete Saturday with Done first"
                  : finalGate === "queued"
                    ? "FINAL is awaiting a successful sync"
                    : finalGate === "confirmed"
                      ? "This week is already finalized"
                      : "Lock this Mon–Sat week after review"
            }
          >
            {finalGate === "queued"
              ? "Saturday FINAL queued"
              : finalGate === "confirmed"
                ? "Saturday FINAL confirmed"
                : "Submit Saturday FINAL"}
          </button>
        </div>
        <div className="action-footnote">
          {saturday && finalGate === "saturday-not-done"
            ? "Finish Saturday with Done first. The final lock stays unavailable until that complete day is queued."
            : saturday && finalGate === "queued"
              ? "FINAL is queued, not yet locked. Keep this Saturday sheet open until Sync confirms it."
              : saturday && finalGate === "ready"
                ? "Saturday is complete. Review the register, then submit FINAL to lock Mon–Sat and open Monday."
                : dayDone
                  ? "Completed days stay locked to protect the daily record. Start the next day for a fresh sheet."
                  : "Worker changes auto-sync when online. Tap Done to queue the complete day — no half-day kg is sent."}
        </div>
        <div className="saturday-note">
          {finalGate === "not-saturday"
            ? "Saturday FINAL is greyed out Monday–Friday. It becomes available only after Saturday Done."
            : finalGate === "saturday-not-done"
              ? "Saturday FINAL is greyed out until Saturday Done is complete."
              : finalGate === "queued"
                ? "Saturday FINAL is waiting for a successful sync; it has not locked the week yet."
                : finalGate === "confirmed"
                  ? "This Saturday was finalized. The next working sheet is Monday."
                  : "Saturday FINAL is available after Done; it locks only this Mon–Sat week."}
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
              <section
                className={`identity-access-card ${privateIdentityAccessReady ? "is-unlocked" : "is-locked"}`}
                aria-live="polite"
              >
                {privateIdentityAccessReady ? (
                  <>
                    <div className="identity-access-heading">
                      <strong>Private ID tools unlocked</strong>
                      <span>Supervisor: {supervisorSession!.username}</span>
                    </div>
                    <p>
                      This farm-only session expires at{" "}
                      {new Date(supervisorSession!.expiresAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}. Private drafts clear when you lock it or go offline.
                    </p>
                    <button
                      className="identity-lock-button"
                      onClick={signOutOfPrivateIdentity}
                    >
                      Lock private ID tools
                    </button>
                  </>
                ) : (
                  <>
                    <div className="identity-access-heading">
                      <strong>Private ID tools are locked</strong>
                      <span>{online ? "Supervisor sign-in required" : "Internet connection required"}</span>
                    </div>
                    <p>
                      You can still register a basic worker and use all daily kg
                      tools offline. National ID details and images are accepted only
                      online after an Admin-provisioned, farm-bound Supervisor sign-in.
                      {!deviceToken && " This first sign-in also secures this field phone for farm sync."}
                    </p>
                    {online && (
                      <div className="identity-signin-row">
                        <input
                          autoCapitalize="none"
                          autoCorrect="off"
                          autoComplete="username"
                          aria-label="Supervisor username"
                          placeholder="Supervisor username"
                          value={supervisorUsername}
                          disabled={supervisorSigningIn}
                          onChange={(e) => setSupervisorUsername(e.target.value)}
                        />
                        <input
                          type="password"
                          autoComplete="current-password"
                          aria-label="Supervisor password"
                          placeholder="Supervisor password"
                          value={supervisorPassword}
                          disabled={supervisorSigningIn}
                          onChange={(e) => setSupervisorPassword(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void signInForPrivateIdentity();
                          }}
                        />
                        <button
                          className="identity-signin-button"
                          disabled={supervisorSigningIn || enrollingDevice || !farmId}
                          onClick={() => void signInForPrivateIdentity()}
                        >
                          {supervisorSigningIn || enrollingDevice
                            ? "Securing…"
                            : deviceToken
                              ? "Sign in"
                              : "Sign in & secure device"}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </section>
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
                  <p className="identity-intake-note">
                    Identity details are private to the Owner/Admin. They are not
                    kept in the phone’s offline queue or shown in the field list.
                  </p>
                  <div className="form-row">
                    <input
                      data-testid="worker-name"
                      placeholder="Full name e.g. Kiptoo Koech"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      disabled={registeringWorker}
                    />
                    <input
                      data-testid="worker-phone"
                      inputMode="tel"
                      placeholder="Phone: 07... or +254..."
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      disabled={registeringWorker}
                    />
                  </div>
                  {privateIdentityAccessReady ? (
                    <div className="form-row" style={{ marginTop: 8 }}>
                      <input
                        data-testid="worker-national-id"
                        inputMode="numeric"
                        placeholder="National ID number"
                        value={nationalIdNumber}
                        onChange={(e) => setNationalIdNumber(e.target.value)}
                        disabled={registeringWorker}
                      />
                      <label className="id-photo-upload">
                        <span>{idPhoto ? `ID photo: ${idPhoto.name}` : "Optional ID photo"}</span>
                        <input
                          data-testid="worker-id-photo"
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          capture="environment"
                          disabled={registeringWorker}
                          onChange={(e) => setIdPhoto(e.target.files?.[0] ?? null)}
                        />
                      </label>
                    </div>
                  ) : (
                    <div className="identity-locked-note">
                      Add a basic worker now. Complete the private ID profile only
                      after Supervisor sign-in while online.
                    </div>
                  )}
                  <label className="consent-line">
                    <input
                      data-testid="consent"
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                      disabled={registeringWorker}
                    />
                    <span>Worker agreed to receive SMS receipts.</span>
                  </label>
                  {privateIdentityAccessReady && (
                    <label className="consent-line identity-consent-line">
                      <input
                        data-testid="identity-consent"
                        type="checkbox"
                        checked={identityConsent}
                        onChange={(e) => setIdentityConsent(e.target.checked)}
                        disabled={registeringWorker}
                      />
                      <span>
                        Worker agreed to private storage of their ID number and,
                        if attached, ID image. Only Owner/Admin can view it.
                      </span>
                    </label>
                  )}
                  <div className="form-actions">
                    <button
                      className="add-worker-submit"
                      data-testid="add-worker"
                      onClick={registerWorker}
                      disabled={registeringWorker}
                    >
                      {registeringWorker
                        ? "Saving securely…"
                        : privateIdentityAccessReady
                          ? "Add worker with private ID"
                          : "Add basic worker"}
                    </button>
                    <button
                      className="cancel-worker"
                      disabled={registeringWorker}
                      onClick={() => {
                        setShowAddWorker(false);
                        setFullName("");
                        setPhone("");
                        setNationalIdNumber("");
                        setIdPhoto(null);
                        setConsent(false);
                        setIdentityConsent(false);
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
                      onClick={() => {
                        const nextWorkerId =
                          w.worker_id === selectedWorkerId ? "" : w.worker_id;
                        setSelectedWorkerId(nextWorkerId);
                        setProfileNationalIdNumber("");
                        setProfileIdPhoto(null);
                        setProfileIdentityConsent(false);
                      }}
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
                    {privateIdentityAccessReady ? (
                    <div className="identity-completion-card">
                      <div className="form-title">Complete private ID profile</div>
                      <p>
                        Use this for an existing worker. These details go straight
                        to the private Admin profile and are never kept in this
                        phone’s offline queue.
                      </p>
                      <div className="form-row">
                        <input
                          data-testid="existing-worker-national-id"
                          inputMode="numeric"
                          placeholder="National ID number"
                          value={profileNationalIdNumber}
                          disabled={savingProfileIdentity}
                          onChange={(e) => setProfileNationalIdNumber(e.target.value)}
                        />
                        <label className="id-photo-upload">
                          <span>
                            {profileIdPhoto
                              ? `ID photo: ${profileIdPhoto.name}`
                              : "Optional ID photo"}
                          </span>
                          <input
                            data-testid="existing-worker-id-photo"
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            capture="environment"
                            disabled={savingProfileIdentity}
                            onChange={(e) => setProfileIdPhoto(e.target.files?.[0] ?? null)}
                          />
                        </label>
                      </div>
                      <label className="consent-line identity-consent-line">
                        <input
                          data-testid="existing-worker-identity-consent"
                          type="checkbox"
                          checked={profileIdentityConsent}
                          disabled={savingProfileIdentity}
                          onChange={(e) => setProfileIdentityConsent(e.target.checked)}
                        />
                        <span>
                          Worker agreed to private storage of their ID number and,
                          if attached, ID image. Only Owner/Admin can view it.
                        </span>
                      </label>
                      <button
                        className="add-worker-submit identity-completion-submit"
                        disabled={savingProfileIdentity}
                        onClick={completeWorkerIdentity}
                      >
                        {savingProfileIdentity
                          ? "Saving securely…"
                          : "Save private ID profile"}
                      </button>
                    </div>
                    ) : (
                      <div className="identity-completion-card identity-locked-note">
                        <div className="form-title">Private ID profile locked</div>
                        <p>
                          Sign in as this farm's Supervisor while online before
                          entering or completing a worker's private ID profile.
                        </p>
                      </div>
                    )}
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
