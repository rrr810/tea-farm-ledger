import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearNativeSyncState,
  mirrorNativeDeviceAccess,
  mirrorNativeQueuedEvents,
  nativeHasPendingEvents,
  removeNativeQueuedEvents,
  takeNativeAcknowledgedEventIds,
} from "../apps/supervisor-pwa/src/nativeSync.js";

const farmId = "00000000-0000-4000-a000-000000000701";
const deviceId = "00000000-0000-4000-a000-000000000702";
const eventId = "00000000-0000-4000-a000-000000000703";

function installBridge(acknowledgements: string | null = "[]", pending = false) {
  const saveDeviceAccess = vi.fn();
  const queueEvents = vi.fn();
  const removeQueuedEvents = vi.fn();
  const clearSyncState = vi.fn();
  const startPendingSync = vi.fn();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      TeaLedgerAndroidSync: {
        saveDeviceAccess,
        queueEvents,
        removeQueuedEvents,
        takeAcknowledgedEventIds: vi.fn(() => acknowledgements),
        hasPendingEvents: vi.fn(() => pending),
        clearSyncState,
        startPendingSync,
      },
    },
  });
  return { saveDeviceAccess, queueEvents, removeQueuedEvents, clearSyncState, startPendingSync };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  vi.restoreAllMocks();
});

describe("native Android sync bridge", () => {
  it("mirrors only an already-persisted completed batch and opaque device access", () => {
    const bridge = installBridge();
    mirrorNativeDeviceAccess({ farmId, deviceId, deviceToken: "opaque-device-token" });
    mirrorNativeQueuedEvents([
      {
        event_id: eventId,
        farm_id: farmId,
        payload: {
          event_id: eventId,
          farm_id: farmId,
          device_id: deviceId,
          event_type: "day.confirmed",
        },
        createdAt: "2026-11-05T10:00:00.000Z",
        type: "day.confirmed",
      },
    ]);

    expect(JSON.parse(bridge.saveDeviceAccess.mock.calls[0]![0])).toEqual({
      farmId,
      deviceId,
      deviceToken: "opaque-device-token",
    });
    expect(JSON.parse(bridge.queueEvents.mock.calls[0]![0])).toHaveLength(1);
    expect(bridge.startPendingSync).toHaveBeenCalledTimes(1);

    removeNativeQueuedEvents([eventId]);
    expect(JSON.parse(bridge.removeQueuedEvents.mock.calls[0]![0])).toEqual([eventId]);
  });

  it("accepts only a well-formed native acknowledgement list", () => {
    installBridge(JSON.stringify([eventId, 42, ""]));
    expect(takeNativeAcknowledgedEventIds()).toEqual([eventId]);

    installBridge("not-json");
    expect(takeNativeAcknowledgedEventIds()).toEqual([]);
  });

  it("blocks a relink while Android reports pending work and clears only through the narrow reset bridge", () => {
    const bridge = installBridge("[]", true);
    expect(nativeHasPendingEvents()).toBe(true);
    clearNativeSyncState();
    expect(bridge.clearSyncState).toHaveBeenCalledTimes(1);

    installBridge("[]", false);
    expect(nativeHasPendingEvents()).toBe(false);
  });

  it("fails closed for an older or malformed native bridge during a relink check", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { TeaLedgerAndroidSync: {} },
    });
    expect(nativeHasPendingEvents()).toBe(true);
  });
});
