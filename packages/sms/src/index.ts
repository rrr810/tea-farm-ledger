export * from "./types.js";
export * from "./mock.js";
export * from "./at.js";
export * from "./telnyx.js";
export * from "./mobilesasa.js";
export * from "./live-daily.js";
export * from "./scheduler.js";
import { mockAdapter } from "./mock.js";
import { createATAdapter } from "./at.js";
import { createTelnyxAdapter } from "./telnyx.js";
export function getSmsAdapter(): import("./types.js").SmsAdapter {
  if (
    process.env.SMS_PROVIDER === "telnyx" &&
    process.env.TELNYX_API_KEY &&
    process.env.TELNYX_MESSAGING_PROFILE_ID &&
    process.env.TELNYX_SENDER_ID
  ) {
    return createTelnyxAdapter({
      apiKey: process.env.TELNYX_API_KEY,
      messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID,
      senderId: process.env.TELNYX_SENDER_ID,
      webhookUrl: process.env.TELNYX_WEBHOOK_URL,
    });
  }
  if (process.env.SMS_PROVIDER === "africastalking" && process.env.AT_API_KEY) {
    return createATAdapter({
      apiKey: process.env.AT_API_KEY,
      username: process.env.AT_USERNAME ?? "sandbox",
      senderId: process.env.AT_SENDER_ID,
      sandbox: process.env.SMS_SANDBOX === "true",
    });
  }
  return mockAdapter;
}
