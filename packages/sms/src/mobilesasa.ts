import { countSegments, isGsm7 } from "@tea-ledger/core";
import type { SmsAdapter } from "./types.js";

/**
 * Mobile Sasa v2 sender.
 *
 * Uses a caller-provided trackingId so each persisted sms_messages row has a
 * stable provider reference. The token remains server-side in MOBILESASA_TOKEN.
 * `cost` returned by Mobile Sasa is SMS parts, not Kenyan shillings.
 */
export const MOBILE_SASA_PART_COST_CENTS = 60;

/** The only lifecycle states persisted by Tea Ledger's SMS audit trail. */
export type MobileSasaDeliveryStatus = "queued" | "sent" | "delivered" | "failed";

export type MobileSasaDeliveryLookup = {
  /** False means the provider did not return a usable delivery report. */
  found: boolean;
  status: MobileSasaDeliveryStatus;
  providerMessage: string | null;
  responseCode: string | null;
};

/**
 * Maps only documented Mobile Sasa DLR outcomes. The v2 send acknowledgement is
 * intentionally not promoted beyond `queued`: acceptance is not handset proof.
 */
export function mobileSasaDeliveryStatus(value: string | null | undefined): MobileSasaDeliveryStatus {
  const normalised = (value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (/(failed|rejected|expired|unreachable|undelivered|deliveryimpossible|absentsubscriber|blacklisted)/.test(normalised)) {
    return "failed";
  }
  if (/(delivered|delivrd)/.test(normalised)) return "delivered";
  if (/(sent|acceptedbycarrier|carrieraccepted)/.test(normalised)) return "sent";
  return "queued";
}

/**
 * Read-only Mobile Sasa v1 delivery-report lookup. This endpoint never sends,
 * retries, changes a recipient, or consumes an SMS unit.
 */
export async function lookupMobileSasaDeliveryReport(opts: {
  token: string;
  messageId: string;
  fetchImpl?: typeof fetch;
}): Promise<MobileSasaDeliveryLookup> {
  if (!opts.token) throw new Error("Mobile Sasa token is not configured");
  if (!opts.messageId) throw new Error("Mobile Sasa messageId is required for delivery lookup");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl("https://api.mobilesasa.com/v1/dlr", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messageId: opts.messageId }),
  });
  const json = (await res.json().catch(() => null)) as {
    status?: boolean;
    responseCode?: string;
    message?: string;
  } | null;
  const providerMessage = typeof json?.message === "string" ? json.message : null;
  const responseCode = typeof json?.responseCode === "string" ? json.responseCode : null;
  if (!res.ok || json?.status !== true) {
    return { found: false, status: "queued", providerMessage, responseCode };
  }
  return {
    found: true,
    status: mobileSasaDeliveryStatus(providerMessage),
    providerMessage,
    responseCode,
  };
}

export function createMobileSasaAdapter(opts: {
  token: string;
  senderId?: string;
  /** Injectable only for contract tests. */
  fetchImpl?: typeof fetch;
  /** KES cents per billed SMS part used for the dashboard estimate. */
  partCostCents?: number;
}): SmsAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const senderId = opts.senderId ?? "MOBILESASA";
  const partCostCents = opts.partCostCents ?? MOBILE_SASA_PART_COST_CENTS;

  return {
    name: "mobilesasa",
    async send({ to, body, trackingId }) {
      if (!opts.token) throw new Error("Mobile Sasa token is not configured");
      if (!isGsm7(body)) throw new Error("Daily SMS must be GSM-7 text");
      if (!trackingId) throw new Error("Mobile Sasa trackingId is required");

      const res = await fetchImpl("https://api.mobilesasa.com/v2/send/message", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          senderID: senderId,
          phone: to,
          message: body,
          trackingId,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        status?: boolean;
        responseCode?: string;
        message?: string;
        messageId?: string;
        cost?: number;
      } | null;

      if (!res.ok || json?.status !== true || !json.messageId) {
        const detail = json?.message ?? json?.responseCode ?? `HTTP ${res.status}`;
        throw new Error(`Mobile Sasa send failed: ${detail}`);
      }

      const localSegments = countSegments(body);
      const billedParts = Number.isInteger(json.cost) && Number(json.cost) > 0 ? Number(json.cost) : localSegments;
      return {
        providerId: json.messageId,
        segments: billedParts,
        costEstimateCents: billedParts * partCostCents,
        status: "queued" as const,
      };
    },
  };
}
