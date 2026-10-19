import { z } from "zod";
export const EventType = {
  WORKER_REGISTERED: "worker.registered",
  WORKER_PHONE_CHANGED: "worker.phone_changed",
  WORKER_VERIFIED: "worker.verified",
  EMPLOYMENT_STARTED: "employment.started",
  EMPLOYMENT_ENDED: "employment.ended",
  DAY_PLUCKING_SET: "day.plucking_set",
  PLUCK_LOGGED: "pluck.logged",
  PLUCK_CORRECTED: "pluck.corrected",
  DAY_CONFIRMED: "day.confirmed",
  WEEK_SUBMITTED: "week.submitted",
  RATE_SET: "rate.set",
  FACTORY_SLIP_ENTERED: "factory.slip_entered",
  DEVICE_ENROLLED: "device.enrolled",
  DEVICE_REVOKED: "device.revoked",
  CORRECTION_REQUESTED: "correction.requested",
} as const;
export type EventTypeValue = (typeof EventType)[keyof typeof EventType];
export const eventSchema = z.object({
  event_id: z.string().uuid(),
  farm_id: z.string().uuid(),
  device_id: z.string().uuid().optional(),
  author: z.string().min(1),
  event_type: z.string().min(1),
  payload: z.record(z.unknown()),
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  client_timestamp: z.string().datetime(),
  server_received_at: z.string().datetime().optional(),
  seq: z.number().int().optional(),
});
export type LedgerEvent = z.infer<typeof eventSchema>;
export function generateEventId(): string {
  const ts = Date.now();
  const tsHex = ts.toString(16).padStart(12, "0");
  const rand = [...crypto.getRandomValues(new Uint8Array(10))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const hex = tsHex + rand;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}
export function nowIso(): string {
  return new Date().toISOString();
}
