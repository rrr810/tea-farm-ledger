import type { OutboxEvent } from "./db.js";

/**
 * Optional bridge exposed only by the signed/native Android supervisor shell.
 * The normal browser PWA deliberately continues to operate without it.
 *
 * The bridge receives only the already-enrolled field-device credential and
 * append-only sync events. Supervisor identity sessions, private national-ID
 * drafts, photos, worker screens, and SMS configuration are never bridged.
 */
type AndroidSyncBridge = {
  saveDeviceAccess: (json: string) => void;
  queueEvents: (json: string) => void;
  removeQueuedEvents: (json: string) => void;
  takeAcknowledgedEventIds: () => string | null;
  hasPendingEvents: () => boolean;
  clearSyncState: () => void;
  startPendingSync: () => void;
};

declare global {
  interface Window {
    TeaLedgerAndroidSync?: AndroidSyncBridge;
  }
}

function bridge(): AndroidSyncBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = window.TeaLedgerAndroidSync;
  if (!candidate) return null;
  return candidate;
}

function callSafely(action: () => void): void {
  try {
    action();
  } catch {
    // A native bridge failure must never make the field ledger lose its local
    // PWA outbox. The normal authenticated PWA sync remains the safe fallback.
  }
}

export function mirrorNativeDeviceAccess(opts: {
  farmId: string;
  deviceId: string;
  deviceToken: string;
}): void {
  if (!opts.farmId || !opts.deviceId || !opts.deviceToken) return;
  const native = bridge();
  if (!native) return;
  callSafely(() => native.saveDeviceAccess(JSON.stringify(opts)));
}

/**
 * Mirrors a complete, already-persisted outbox batch to Android. The caller is
 * responsible for passing all kg events and the associated day.confirmed event
 * together, so a native foreground worker cannot upload a half-completed day.
 */
export function mirrorNativeQueuedEvents(events: OutboxEvent[]): void {
  if (events.length === 0) return;
  const native = bridge();
  if (!native) return;
  callSafely(() => {
    native.queueEvents(JSON.stringify(events));
    native.startPendingSync();
  });
}

/** Removes events from the Android mirror after the browser PWA sync succeeds. */
export function removeNativeQueuedEvents(eventIds: string[]): void {
  if (eventIds.length === 0) return;
  const native = bridge();
  if (!native) return;
  callSafely(() => native.removeQueuedEvents(JSON.stringify(eventIds)));
}

/**
 * A farm-link operation must never discard a native background queue. A normal
 * browser has no bridge and therefore reports no native-only pending work.
 */
export function nativeHasPendingEvents(): boolean {
  const native = bridge();
  if (!native) return false;
  try {
    return native.hasPendingEvents() === true;
  } catch {
    // Fail closed: a bridge that cannot report its state is treated as pending
    // so the user cannot relink while delivery status is uncertain.
    return true;
  }
}

/**
 * Clears the Android encrypted device credential, queue, acknowledgements, and
 * scheduled work after a server-approved relink. It is intentionally not a
 * general-purpose bridge operation: the PWA calls it only after proving its
 * own outbox/daily stores are empty and receiving a fresh device credential.
 */
export function clearNativeSyncState(): void {
  const native = bridge();
  if (!native) return;
  callSafely(() => native.clearSyncState());
}

/**
 * Returns IDs acknowledged by a native worker after the server accepted its
 * request. Malformed bridge output is ignored rather than deleting PWA data.
 */
export function takeNativeAcknowledgedEventIds(): string[] {
  const native = bridge();
  if (!native) return [];
  try {
    const raw = native.takeAcknowledgedEventIds();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}
