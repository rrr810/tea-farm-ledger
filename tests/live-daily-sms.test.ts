import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, runMigrations } from "@tea-ledger/database";
import {
  refreshLiveDailyDeliveryReports,
  sendLiveDailySms,
  sendLiveNoPluckingSms,
} from "../packages/sms/src/live-daily.js";

const farmId = "00000000-0000-4000-a000-000000000811";
const workerA = "00000000-0000-4000-a000-000000000812";
const workerB = "00000000-0000-4000-a000-000000000813";
const date = "2026-10-24";

beforeAll(async () => {
  process.env.USE_PGLITE = "true";
  process.env.DAILY_LIVE_SMS_ENABLED = "true";
  process.env.DAILY_LIVE_SMS_FARM_ID = farmId;
  process.env.DAILY_LIVE_SMS_OWNER_TEST_PHONE = "0740793959";
  process.env.MOBILESASA_TOKEN = "mbs_test_only";
  const db = await getDb();
  await runMigrations(db);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [farmId, "Live daily test"]);
  await db.query("INSERT INTO rates (farm_id, effective_from, rate_cents_per_kg) VALUES ($1,$2,$3)", [farmId, "2020-01-01", 900]);
  await db.query(
    "INSERT INTO workers (worker_id, farm_id, full_name, phone_e164, status, verified, consent_at, consent_author) VALUES ($1,$2,$3,$4,'active',false,NOW(),'supervisor'),($5,$2,$6,$7,'active',false,NOW(),'supervisor')",
    [workerA, farmId, "Anne K", "+254700000812", workerB, "Maggie Jep", "+254700000813"],
  );
  await db.query(
    "INSERT INTO employment_periods (id, worker_id, farm_id, start_date) VALUES ($1,$2,$3,$4),($5,$6,$3,$4)",
    ["00000000-0000-4000-a000-000000000817", workerA, farmId, "2020-01-01", "00000000-0000-4000-a000-000000000818", workerB],
  );
  for (const [workerId, kg, id] of [[workerA, 450, "00000000-0000-4000-a000-000000000814"], [workerB, 450, "00000000-0000-4000-a000-000000000815"]] as const) {
    await db.query(
      "INSERT INTO events (event_id, farm_id, device_id, author, event_type, payload, business_date, client_timestamp) VALUES ($1,$2,$3,'supervisor','pluck.logged',$4::jsonb,$5,NOW())",
      [id, farmId, "00000000-0000-4000-a000-000000000816", JSON.stringify({ worker_id: workerId, kg_units: kg, present: true }), date],
    );
  }
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.DAILY_LIVE_SMS_ENABLED;
  delete process.env.DAILY_LIVE_SMS_FARM_ID;
  delete process.env.DAILY_LIVE_SMS_OWNER_TEST_PHONE;
  delete process.env.MOBILESASA_TOKEN;
  await closeDb();
});

describe("live daily SMS", () => {
  it("sends one idempotent worker message per consented entry and routes Peter's owner summary to the temporary test phone", async () => {
    let n = 0;
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: true, responseCode: "0200", messageId: `provider-${++n}`, cost: 1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await sendLiveDailySms({ farmId, date });
    expect(first.skipped).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const payloads = fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(payloads.map((p) => p.phone).sort()).toEqual(["+254700000812", "+254700000813", "+254740793959"].sort());
    expect(payloads.find((p) => p.phone === "+254700000812").message).toBe("Dear Anne, your tea record for 24 Oct is 45.0kg. Estimated pay: KES 405.");
    expect(payloads.find((p) => p.phone === "+254700000813").message).toBe("Dear Maggie, your tea record for 24 Oct is 45.0kg. Estimated pay: KES 405.");
    expect(payloads.find((p) => p.phone === "+254740793959").message).toContain("2 pickers, 90.0kg");
    expect(payloads.every((p) => typeof p.trackingId === "string" && p.trackingId.length > 0)).toBe(true);

    const db = await getDb();
    const rows = await db.query("SELECT type, status, segments, cost_estimate_cents FROM sms_messages WHERE farm_id=$1 ORDER BY type", [farmId]);
    expect(rows.rows).toEqual([
      expect.objectContaining({ type: "daily-owner-live", status: "queued", segments: 1, cost_estimate_cents: 60 }),
      expect.objectContaining({ type: "daily-worker-live", status: "queued", segments: 1, cost_estimate_cents: 60 }),
      expect.objectContaining({ type: "daily-worker-live", status: "queued", segments: 1, cost_estimate_cents: 60 }),
    ]);

    const second = await sendLiveDailySms({ farmId, date });
    expect(second.skipped).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3); // repeat sync cannot duplicate a handset message

    // A consented picker who was employed that day but has no entered kg is
    // still notified honestly; the owner summary remains idempotent.
    await db.query(
      "INSERT INTO workers (worker_id, farm_id, full_name, phone_e164, status, verified, consent_at, consent_author) VALUES ($1,$2,$3,$4,'active',false,NOW(),'supervisor')",
      ["00000000-0000-4000-a000-000000000819", farmId, "No Entry", "+254700000819"],
    );
    await db.query(
      "INSERT INTO employment_periods (id, worker_id, farm_id, start_date) VALUES ($1,$2,$3,$4)",
      ["00000000-0000-4000-a000-000000000820", "00000000-0000-4000-a000-000000000819", farmId, "2020-01-01"],
    );
    await sendLiveDailySms({ farmId, date });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const noEntryPayload = JSON.parse((fetchMock.mock.calls[3][1] as RequestInit).body as string);
    expect(noEntryPayload.phone).toBe("+254700000819");
    expect(noEntryPayload.message).toBe("Dear No, your tea record for 24 Oct has no kg or pay recorded today.");
  });

  it("sends no-plucking wording once to every consented roster member plus the temporary owner recipient", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: true, responseCode: "0200", messageId: crypto.randomUUID(), cost: 1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendLiveNoPluckingSms({ farmId, date: "2026-10-25", reason: "Heavy rain " + "x".repeat(200) });
    expect(result.skipped).toBe(false);
    // 3 employed consented workers in this fixture, plus one owner/Peter summary.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const payloads = fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(payloads.find((payload) => payload.phone === "+254700000812").message).toMatch(/^Dear Anne, no plucking on 25 Oct\. Reason: Heavy rain x+/);
    expect(payloads.find((payload) => payload.phone === "+254700000813").message).toMatch(/^Dear Maggie, no plucking on 25 Oct\. Reason: Heavy rain x+/);
    expect(payloads.find((payload) => payload.phone === "+254740793959").message).toContain("no plucking today");
    expect(payloads.every((payload) => payload.message.length <= 160)).toBe(true);
    expect(payloads.map((payload) => payload.phone)).toContain("+254740793959");
  });

  it("reconciles existing accepted messages through injected read-only DLR lookup without sending", async () => {
    const db = await getDb();
    const pending = await db.query(
      "SELECT id, provider_id FROM sms_messages WHERE farm_id=$1 AND provider_id IS NOT NULL AND status='queued' ORDER BY created_at ASC",
      [farmId],
    );
    const firstProviderId = (pending.rows as Array<{ provider_id: string }>)[0]!.provider_id;
    const noSendFetch = vi.fn();
    vi.stubGlobal("fetch", noSendFetch);
    const lookup = vi.fn(async ({ messageId }: { messageId: string }) => ({
      found: true,
      status: messageId === firstProviderId ? ("delivered" as const) : ("queued" as const),
      providerMessage: messageId === firstProviderId ? "Delivered" : "Queued",
      responseCode: "0200",
    }));

    const result = await refreshLiveDailyDeliveryReports({ farmId, dbClient: db as never, lookup });

    expect(result.checked).toBe(pending.rows.length);
    expect(result.delivered).toBe(1);
    expect(result.updated).toBe(1);
    expect(lookup).toHaveBeenCalledTimes(pending.rows.length);
    expect(noSendFetch).not.toHaveBeenCalled();
    const updated = await db.query("SELECT status FROM sms_messages WHERE provider_id=$1", [firstProviderId]);
    expect((updated.rows as Array<{ status: string }>)[0]?.status).toBe("delivered");
  });

  it("does not create failed idempotency rows for a partly configured deployment", async () => {
    const db = await getDb();
    const before = await db.query("SELECT COUNT(*)::int AS count FROM sms_messages WHERE farm_id=$1", [farmId]);
    const savedToken = process.env.MOBILESASA_TOKEN;
    delete process.env.MOBILESASA_TOKEN;
    try {
      await expect(sendLiveDailySms({ farmId, date })).resolves.toMatchObject({ skipped: true, reason: "Mobile Sasa token is not configured" });
      const after = await db.query("SELECT COUNT(*)::int AS count FROM sms_messages WHERE farm_id=$1", [farmId]);
      expect(after.rows).toEqual(before.rows);
    } finally {
      process.env.MOBILESASA_TOKEN = savedToken;
    }
  });
});
