import { countSegments } from "@tea-ledger/core";
import type { SmsAdapter } from "./types.js";
export function createATAdapter(opts: { apiKey: string; username: string; senderId?: string; sandbox: boolean }): SmsAdapter {
  return {
    name: "africastalking",
    async send({ to, body }) {
      const segments = countSegments(body);
      if (process.env.SMS_PROVIDER !== "africastalking") {
        return { providerId: `mock-${Date.now()}`, segments, status: "queued" };
      }
      const endpoint = opts.sandbox ? "https://api.sandbox.africastalking.com/version1/messaging" : "https://api.africastalking.com/version1/messaging";
      console.log(`[AT] Would POST ${endpoint} to=${to} sender=${opts.senderId} segments=${segments}`);
      return { providerId: `at-${Date.now()}`, segments, status: "queued" };
    },
  };
}
