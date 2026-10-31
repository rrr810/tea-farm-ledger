import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMobileSasaAdapter,
  lookupMobileSasaDeliveryReport,
  mobileSasaDeliveryStatus,
} from "../packages/sms/src/mobilesasa.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("Mobile Sasa v2 daily SMS adapter", () => {
  it("uses the server-side bearer token, approved shared sender, and stable tracking id", async () => {
    const fn = stubFetch(200, {
      status: true,
      responseCode: "0200",
      message: "Accepted",
      messageId: "ms-accepted-1",
      cost: 1,
    });
    const adapter = createMobileSasaAdapter({ token: "mbs_test_token", partCostCents: 60 });

    const result = await adapter.send({
      to: "+254740793959",
      body: "Tea Ledger 24 Oct: 45.0kg, estimated pay KES 405.",
      farmId: "farm-1",
      type: "daily-worker-live",
      trackingId: "a2da64ff-812d-4cdf-8d5f-2f0b05c0c001",
    });

    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mobilesasa.com/v2/send/message");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer mbs_test_token");
    const payload = JSON.parse(init.body as string);
    expect(payload).toEqual({
      senderID: "MOBILESASA",
      phone: "+254740793959",
      message: "Tea Ledger 24 Oct: 45.0kg, estimated pay KES 405.",
      trackingId: "a2da64ff-812d-4cdf-8d5f-2f0b05c0c001",
    });
    expect(result).toEqual({ providerId: "ms-accepted-1", segments: 1, costEstimateCents: 60, status: "queued" });
  });

  it("uses the provider-returned billed part count for the cost estimate", async () => {
    stubFetch(200, { status: true, messageId: "ms-accepted-2", cost: 2 });
    const adapter = createMobileSasaAdapter({ token: "mbs_test_token", partCostCents: 60 });
    const result = await adapter.send({
      to: "+254740793959",
      body: "x".repeat(170),
      farmId: "farm-1",
      type: "daily-owner-live",
      trackingId: "b2da64ff-812d-4cdf-8d5f-2f0b05c0c001",
    });
    expect(result.segments).toBe(2);
    expect(result.costEstimateCents).toBe(120);
  });

  it("fails closed on provider refusal and never labels it as a send", async () => {
    stubFetch(200, { status: false, responseCode: "0402", message: "Insufficient units" });
    const adapter = createMobileSasaAdapter({ token: "mbs_test_token" });
    await expect(adapter.send({
      to: "+254740793959",
      body: "Tea Ledger 24 Oct: no plucking today.",
      farmId: "farm-1",
      type: "no-plucking-worker-live",
      trackingId: "c2da64ff-812d-4cdf-8d5f-2f0b05c0c001",
    })).rejects.toThrow(/Insufficient units/);
  });

  it("requires GSM-7 text and a tracking id before calling the provider", async () => {
    const fn = stubFetch(200, { status: true, messageId: "unused", cost: 1 });
    const adapter = createMobileSasaAdapter({ token: "mbs_test_token" });
    await expect(adapter.send({ to: "+254740793959", body: "Rain 😀", farmId: "farm-1", type: "daily-worker-live", trackingId: "id" })).rejects.toThrow(/GSM-7/);
    await expect(adapter.send({ to: "+254740793959", body: "Rain", farmId: "farm-1", type: "daily-worker-live" })).rejects.toThrow(/trackingId/);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("Mobile Sasa delivery-report lookup", () => {
  it("uses the read-only DLR endpoint and maps a real Delivered response", async () => {
    const fn = stubFetch(200, { status: true, responseCode: "0200", message: "Delivered" });
    const report = await lookupMobileSasaDeliveryReport({
      token: "mbs_test_token",
      messageId: "provider-message-1",
    });

    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mobilesasa.com/v1/dlr");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer mbs_test_token");
    expect(JSON.parse(init.body as string)).toEqual({ messageId: "provider-message-1" });
    expect(report).toEqual({
      found: true,
      status: "delivered",
      providerMessage: "Delivered",
      responseCode: "0200",
    });
  });

  it("never converts unavailable or unknown provider replies into a delivery claim", async () => {
    stubFetch(404, { status: false, responseCode: "0404", message: "Not found" });
    const report = await lookupMobileSasaDeliveryReport({ token: "mbs_test_token", messageId: "missing" });
    expect(report).toMatchObject({ found: false, status: "queued", providerMessage: "Not found" });
    expect(mobileSasaDeliveryStatus("Unreachable")).toBe("failed");
    expect(mobileSasaDeliveryStatus("Sent")).toBe("sent");
    expect(mobileSasaDeliveryStatus("Accepted")).toBe("queued");
  });
});
