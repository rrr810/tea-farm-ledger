import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

describe("owner-console expired-session handling", () => {
  beforeEach(() => {
    vi.resetModules();
    const events = new EventTarget();
    vi.stubGlobal(
      "window",
      {
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears a stale stored session and announces a protected-route 401 once", async () => {
    const storage = memoryStorage({
      admin_token: "stale-token",
      farm_id: "00000000-0000-4000-a000-0000000000a1",
    });
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"error":"admin session is invalid or expired"}', { status: 401 }),
      ),
    );

    const { ADMIN_SESSION_EXPIRED_EVENT, api } = await import(
      "../apps/admin-web/src/api.js"
    );
    const onExpired = vi.fn();
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, onExpired);

    await expect(api.me()).rejects.toThrow("Your owner session expired. Sign in again.");
    expect(storage.getItem("admin_token")).toBeNull();
    expect(storage.getItem("farm_id")).toBeNull();
    expect(onExpired).toHaveBeenCalledTimes(1);

    // Parallel failed responses must not repeatedly trigger logout UI.
    await expect(api.farms()).rejects.toThrow("401");
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("does not treat an unsuccessful login as an existing-session expiry", async () => {
    const storage = memoryStorage({
      admin_token: "existing-token",
      farm_id: "00000000-0000-4000-a000-0000000000a1",
    });
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"error":"invalid credentials"}', { status: 401 })),
    );

    const { ADMIN_SESSION_EXPIRED_EVENT, api } = await import(
      "../apps/admin-web/src/api.js"
    );
    const onExpired = vi.fn();
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, onExpired);

    await expect(api.login("admin", "wrong-password")).rejects.toThrow("401");
    expect(storage.getItem("admin_token")).toBe("existing-token");
    expect(storage.getItem("farm_id")).not.toBeNull();
    expect(onExpired).not.toHaveBeenCalled();
  });
});
