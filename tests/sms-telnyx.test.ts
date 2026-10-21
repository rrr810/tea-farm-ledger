/**
 * Telnyx adapter tests — request/response contract against a stubbed fetch.
 * API contract source: https://developers.telnyx.com/api-reference/messages/send-a-message
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createTelnyxAdapter } from "../packages/sms/src/telnyx.js";

const adapter = createTelnyxAdapter({
  apiKey: "KEY_TEST",
  messagingProfileId: "prof-123",
  senderId: "TEAFARM",
  usdKesRate: 100, // deterministic estimate: parts * 3.3 * 100
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("telnyx adapter", () => {
  it("POSTs to the Messages API with documented fields", async () => {
    const fn = stubFetch(200, {
      data: { id: "msg-1", to: [{ phone_number: "+254712345678", status: "queued" }], cost: { amount: "0.033", currency: "USD" } },
    });
    const res = await adapter.send({ to: "+254712345678", body: "TEA Mon 19Oct\nTotal 20kg", farmId: "f1", type: "daily-owner" });
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telnyx.com/v2/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer KEY_TEST");
    const payload = JSON.parse(init.body as string);
    expect(payload.to).toBe("+254712345678");
    expect(payload.from).toBe("TEAFARM");
    expect(payload.messaging_profile_id).toBe("prof-123"); // required with alphanumeric sender
    expect(payload.text).toBe("TEA Mon 19Oct\nTotal 20kg");
    expect(payload.webhook_url).toBeUndefined();
    // response mapping
    expect(res.providerId).toBe("msg-1");
    expect(res.status).toBe("queued");
    expect(res.segments).toBe(1);
    expect(res.costEstimateCents).toBe(Math.round(1 * 3.3 * 100));
  });

  it("maps status 'sent' and counts concatenated segments", async () => {
    stubFetch(200, { data: { id: "msg-2", to: [{ status: "sent" }] } });
    const long = "x".repeat(170); // 2 segments (153 concatenated)
    const res = await adapter.send({ to: "+254712345678", body: long, farmId: "f1", type: "weekly-receipt" });
    expect(res.status).toBe("sent");
    expect(res.segments).toBe(2);
    expect(res.costEstimateCents).toBe(Math.round(2 * 3.3 * 100));
  });

  it("throws with the provider error detail on non-2xx (so nothing is logged as sent)", async () => {
    stubFetch(422, { errors: [{ code: "10015", detail: "Invalid Idempotency-Key" }] });
    await expect(
      adapter.send({ to: "+254712345678", body: "hi", farmId: "f1", type: "daily-owner" }),
    ).rejects.toThrow(/Invalid Idempotency-Key/);
  });

  it("throws on malformed success body", async () => {
    stubFetch(200, { unexpected: true });
    await expect(adapter.send({ to: "+254712345678", body: "hi", farmId: "f1", type: "daily-owner" })).rejects.toThrow(/telnyx send failed/);
  });
});
