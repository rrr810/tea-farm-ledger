import { z } from "zod";
export const farmSettingsSchema = z.object({
  rateCentsPerKg: z.number().int().min(0).default(900),
  maxKgPerWorkerDay: z.number().int().min(1).max(2000).default(600),
  factoryToleranceBps: z.number().int().min(0).max(10000).default(500),
  anomalyDeviationBps: z.number().int().min(0).max(20000).default(5000),
  fridayEstimateTimeEAT: z.string().regex(/^\d{2}:\d{2}$/).default("17:00"),
  saturdayReminderTimeEAT: z.string().regex(/^\d{2}:\d{2}$/).default("14:30"),
  smsLanguage: z.enum(["en", "sw"]).default("en"),
  hireFirePermissions: z.enum(["supervisor_enabled", "admin_only"]).default("supervisor_enabled"),
  smsProvider: z.enum(["mock", "africastalking"]).default("mock"),
  smsSandbox: z.boolean().default(true),
  senderId: z.string().max(11).optional(),
  ownerPhoneE164: z.string().regex(/^\+254(7\d{8}|1\d{8})$/).optional(),
  supervisorPhoneE164: z.string().regex(/^\+254(7\d{8}|1\d{8})$/).optional(),
});
export type FarmSettings = z.infer<typeof farmSettingsSchema>;
export const defaultFarmSettings: FarmSettings = farmSettingsSchema.parse({});
export function parseFarmSettings(input: unknown): FarmSettings {
  return farmSettingsSchema.parse(input);
}
export function validateFarmSettings(input: unknown) {
  return farmSettingsSchema.safeParse(input);
}
export function bpsToPercent(bps: number): number {
  return bps / 100;
}
export function centsToKes(cents: number): number {
  return cents / 100;
}
export function kesToCents(kes: number): number {
  return Math.round(kes * 100);
}
export function tenthsToKg(units: number): number {
  return units / 10;
}
export function kgToTenths(kg: number): number {
  return Math.round(kg * 10);
}
