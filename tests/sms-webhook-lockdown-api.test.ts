import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../apps/api/src/index.js";
import { closeDb, getDb, runMigrations } from "@tea-ledger/database";

let app: FastifyInstance;

beforeAll(async () => {
  process.env.USE_PGLITE = "true";
  delete process.env.SMS_PROVIDER;
  delete process.env.TELNYX_WEBHOOK_SECRET;
  delete process.env.MOBILESASA_WEBHOOK_SECRET;
  const db = await getDb();
  await runMigrations(db);
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb();
  delete process.env.SMS_PROVIDER;
  delete process.env.TELNYX_WEBHOOK_SECRET;
  delete process.env.MOBILESASA_WEBHOOK_SECRET;
});

describe("delivery callback lockdown", () => {
  it("fails closed when no provider callback is explicitly configured", async () => {
    const telnyx = await app.inject({
      method: "POST",
      url: "/api/sms/delivery-report",
      payload: { data: { id: "ignored", event_type: "message.sent" } },
    });
    expect(telnyx.statusCode).toBe(404);

    const mobileSasa = await app.inject({
      method: "POST",
      url: "/api/sms/mobilesasa-delivery-report",
      payload: { reference: "ignored", status: "delivered" },
    });
    expect(mobileSasa.statusCode).toBe(404);
  });

  it("requires a configured callback secret before any delivery record can be changed", async () => {
    process.env.SMS_PROVIDER = "telnyx";
    process.env.TELNYX_WEBHOOK_SECRET = "test-telnyx-callback-secret";
    process.env.MOBILESASA_WEBHOOK_SECRET = "test-mobilesasa-callback-secret";

    const noTelnyxSecret = await app.inject({
      method: "POST",
      url: "/api/sms/delivery-report",
      payload: { data: { id: "ignored", event_type: "message.sent" } },
    });
    expect(noTelnyxSecret.statusCode).toBe(401);
    const badTelnyxSecret = await app.inject({
      method: "POST",
      url: "/api/sms/delivery-report",
      headers: { "x-telnyx-webhook-secret": "wrong" },
      payload: { data: { id: "ignored", event_type: "message.sent" } },
    });
    expect(badTelnyxSecret.statusCode).toBe(401);

    const noMobileSasaSecret = await app.inject({
      method: "POST",
      url: "/api/sms/mobilesasa-delivery-report",
      payload: { reference: "ignored", status: "delivered" },
    });
    expect(noMobileSasaSecret.statusCode).toBe(401);
    const badMobileSasaSecret = await app.inject({
      method: "POST",
      url: "/api/sms/mobilesasa-delivery-report",
      headers: { "x-mobilesasa-secret": "wrong" },
      payload: { reference: "ignored", status: "delivered" },
    });
    expect(badMobileSasaSecret.statusCode).toBe(401);
  });
});
