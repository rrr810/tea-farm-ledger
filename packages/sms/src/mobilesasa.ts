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
