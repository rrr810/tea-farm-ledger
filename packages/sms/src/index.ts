export * from "./types.js";
export * from "./mock.js";
export * from "./at.js";
export * from "./scheduler.js";
import { mockAdapter } from "./mock.js";
import { createATAdapter } from "./at.js";
export function getSmsAdapter(): import("./types.js").SmsAdapter {
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
