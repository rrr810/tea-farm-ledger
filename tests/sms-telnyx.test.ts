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

describe("delivery reports (matched by provider_id)", () => {
  it("updates status on the stored SMS and no-ops for unknown ids", async () => {
    const { createTestDb, runMigrations } = await import("@tea-ledger/database");
    const { applyDeliveryReport } = await import("../packages/sms/src/scheduler.js");
    const db = await createTestDb();
    await runMigrations(db);
    await db.query("INSERT INTO farms (farm_id, name) VALUES ('00000000-0000-4000-a000-0000000000cc','DLR Farm')");
    await db.query(
      "INSERT INTO sms_messages (id, farm_id, type, to_phone, body, segments, status, provider_id, job_key) VALUES ('00000000-0000-4000-a000-0000000000dd','00000000-0000-4000-a000-0000000000cc','daily-owner','+254712345678','hello',1,'queued','telnyx-msg-1','k1')",
    );
    const n = await applyDeliveryReport("telnyx-msg-1", "delivered", db as never);
    expect(n).toBe(1);
    const row = (await db.query("SELECT status FROM sms_messages WHERE provider_id='telnyx-msg-1'")).rows[0] as { status: string };
    expect(row.status).toBe("delivered");
    expect(await applyDeliveryReport("nope", "failed", db as never)).toBe(0);
    if (db?.end) await db.end();
  });
});
