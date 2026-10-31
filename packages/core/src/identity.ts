/**
 * Normalize a Kenyan national-ID-style number for private worker identity
 * records. We deliberately accept a conservative numeric range instead of
 * trying to infer document type or citizenship from the number.
 */
export type NationalIdResult =
  | { ok: true; value: string }
  | { ok: false; reason: string; code: string };

export function normalizeNationalIdNumber(input: string): NationalIdResult {
  if (typeof input !== "string") {
    return { ok: false, reason: "ID number is required", code: "ID_REQUIRED" };
  }
  const value = input.replace(/\s+/g, "");
  if (!value) {
    return { ok: false, reason: "ID number is required", code: "ID_REQUIRED" };
  }
  // Keep the validation narrow enough to reject accidental phone numbers and
  // punctuation, while avoiding unsupported assumptions about a worker's ID.
  if (!/^\d{6,12}$/.test(value)) {
    return {
      ok: false,
      reason: "ID number must contain 6 to 12 digits",
      code: "ID_FORMAT",
    };
  }
  return { ok: true, value };
}
