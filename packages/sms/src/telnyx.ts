import { countSegments } from "@tea-ledger/core";
import type { SmsAdapter } from "./types.js";

/**
 * Telnyx Messages API adapter — real HTTP send.
 * API ref: https://developers.telnyx.com/api-reference/messages/send-a-message
 *   POST https://api.telnyx.com/v2/messages
 *   Authorization: Bearer <TELNYX_API_KEY>
 *   Body: { to, from, messaging_profile_id, text }
 *     - `to`: E.164 phone number
 *     - `from`: alphanumeric Sender ID (e.g. "TEAFARM") — permitted for Kenya,
 *       but Kenya REQUIRES Sender ID registration first (Telnyx "Kenya: SMS
 *       Guidelines"); generic alpha IDs are discouraged and must relate to content.
 *     - `messaging_profile_id`: REQUIRED when sending with an alphanumeric sender.
 *     - `text`: message body (GSM-7 only in this system — see @tea-ledger/core).
 *   Response 200: { data: { id, to: [{ status: "queued" | ... }], cost: { amount, currency }, parts } }
 *   Errors: non-2xx { errors: [{ code, title, detail }] }.
 *
 * Known Telnyx constraints (documented, do not "fix" silently):
 *   - Alphanumeric Sender IDs are ONE-WAY: recipients cannot reply. Phase 2's
 *     Owner "YES" pre-approval flow therefore cannot ride this channel; it needs
 *     a real number/shortcode from a local provider when Phase 2 starts.
 *   - Kenya sender ID registration is manual (alpha_sender_id@telnyx.com) and may
 *     require Level 2 account verification.
 *   - Cost per part is the international-alphanumeric rate (~USD 0.033/part list,
 *     Sep 2026) — 5-10x local routes. Acceptable at pilot volume (~200 SMS/mo);
 *     revisit before multi-farm scale.
 *
 * Delivery reports: Telnyx posts message lifecycle events (message.sent /
 * message.delivered / message.finalized) to `webhook_url`. We store `providerId`
 * (the Telnyx message id) on every sms_messages row so a callback route can match
 * and update `status` when that route is added (see docs/DECISIONS.md J11).
 */
export function createTelnyxAdapter(opts: {
  apiKey: string;
  messagingProfileId: string;
  senderId: string;
  webhookUrl?: string;
  /** KES per USD used only for the cost ESTIMATE shown in the SMS log (default 130). */
  usdKesRate?: number;
}): SmsAdapter {
  return {
    name: "telnyx",
    async send({ to, body }) {
      const segments = countSegments(body);
      const res = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to,
          from: opts.senderId,
          messaging_profile_id: opts.messagingProfileId,
          text: body,
          ...(opts.webhookUrl ? { webhook_url: opts.webhookUrl } : {}),
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        data?: {
          id?: string;
          to?: Array<{ status?: string }>;
          cost?: { amount?: string };
        };
        errors?: Array<{ detail?: string; title?: string }>;
      } | null;
      if (!res.ok || !json?.data) {
        const detail = json?.errors?.[0]?.detail ?? json?.errors?.[0]?.title ?? `HTTP ${res.status}`;
        throw new Error(`telnyx send failed: ${detail}`);
      }
      const toStatus = json.data.to?.[0]?.status;
      const status: "sent" | "queued" = toStatus === "sent" ? "sent" : "queued";
      // Estimate in KES cents: list alpha rate ~USD 0.033/part (Sep 2026) x FX.
      const fx = opts.usdKesRate ?? 130;
      const costEstimateCents = Math.round(segments * 3.3 * fx);
      return { providerId: json.data.id, segments, costEstimateCents, status };
    },
  };
}
