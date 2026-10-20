/**
 * Kenyan phone normalization — Decision #19, #17
 * Accepts 07xx, 01xx, 2547..., +254..., 7xx, 1xx
 * Normalizes to E.164: +2547xxxxxxxx or +2541xxxxxxxx
 */
export const KENYAN_E164_REGEX = /^\+254(7\d{8}|1\d{8})$/;
export const KENYAN_07_REGEX = /^0(7\d{8}|1\d{8})$/;
export type NormalizationResult =
  | { ok: true; e164: string }
  | { ok: false; reason: string };
export function normalizeKePhone(input: string): NormalizationResult {
  if (!input || typeof input !== "string") {
    return { ok: false, reason: "empty phone" };
  }
  let s = input.trim().replace(/[\s\-()]/g, "");
  if (!s) return { ok: false, reason: "empty phone" };
  if (s.startsWith("+")) {
    if (KENYAN_E164_REGEX.test(s)) return { ok: true, e164: s };
    return { ok: false, reason: "invalid E.164" };
  }
  if (s.startsWith("254")) {
    const e164 = `+${s}`;
    if (KENYAN_E164_REGEX.test(e164)) return { ok: true, e164 };
    return { ok: false, reason: "invalid 254 format" };
  }
  if (s.startsWith("0")) {
    if (KENYAN_07_REGEX.test(s)) {
      return { ok: true, e164: `+254${s.slice(1)}` };
    }
    return { ok: false, reason: "invalid 0-prefixed format" };
  }
  if (/^(7\d{8}|1\d{8})$/.test(s)) {
    return { ok: true, e164: `+254${s}` };
  }
  return { ok: false, reason: "unrecognized format" };
}
export function isValidKePhone(input: string): boolean {
  return normalizeKePhone(input).ok;
}
export function maskPhone(e164: string): string {
  if (!KENYAN_E164_REGEX.test(e164)) return "***";
  return `${e164.slice(0, 5)}***${e164.slice(-4)}`;
}
