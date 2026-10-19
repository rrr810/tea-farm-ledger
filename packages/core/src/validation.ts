import { normalizeKePhone } from "./phone.js";
export const MAX_KG_PER_WORKER_DAY_TENTHS = 600;
export type ValidationResult = { valid: true } | { valid: false; reason: string; code: string };
export function validateKgTenths(kgUnits: number, max = MAX_KG_PER_WORKER_DAY_TENTHS): ValidationResult {
  if (!Number.isInteger(kgUnits)) return { valid: false, reason: "kg must be integer tenths", code: "KG_NOT_INTEGER" };
  if (kgUnits < 0) return { valid: false, reason: "negative kg", code: "KG_NEGATIVE" };
  if (kgUnits > max) return { valid: false, reason: `implausible kg > ${max / 10}kg`, code: "KG_IMPLAUSIBLE" };
  return { valid: true };
}
export function validateWorkerName(name: string): ValidationResult {
  if (!name || typeof name !== "string" || !name.trim()) return { valid: false, reason: "name required", code: "NAME_REQUIRED" };
  if (name.trim().length < 2) return { valid: false, reason: "name too short", code: "NAME_SHORT" };
  if (name.trim().length > 100) return { valid: false, reason: "name too long", code: "NAME_LONG" };
  return { valid: true };
}
export function validatePhoneForWorker(phone: string): ValidationResult {
  const res = normalizeKePhone(phone);
  if (!res.ok) return { valid: false, reason: res.reason, code: "PHONE_INVALID" };
  return { valid: true };
}
export function validateBusinessDate(dateStr: string): ValidationResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { valid: false, reason: "date must be YYYY-MM-DD", code: "DATE_FORMAT" };
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return { valid: false, reason: "invalid date", code: "DATE_INVALID" };
  return { valid: true };
}
