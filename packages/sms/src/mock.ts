import { countSegments } from "@tea-ledger/core";
import type { SmsAdapter } from "./types.js";
export const mockAdapter: SmsAdapter = {
  name: "mock",
  async send({ to, body }) {
    const segments = countSegments(body);
    return { providerId: `mock-${Date.now()}`, segments, status: "queued" as const };
  },
};
export const mockLog: Array<{ to: string; body: string; segments: number; at: string }> = [];
export function clearMockLog() { mockLog.length = 0; }
