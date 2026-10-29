export type KgInputParse =
  | { kind: "empty"; text: "" }
  | { kind: "valid"; text: string; kgUnits: number }
  | { kind: "incomplete"; text: string }
  | { kind: "invalid"; text: string; message: string };

/**
 * Parses a field-entry kg value without floating-point arithmetic.
 * We store kilograms as integer tenths, so `34.3` becomes `343`.
 */
export function parseKgInput(raw: string): KgInputParse {
  const text = raw.trim().replace(",", ".");
  if (text === "") return { kind: "empty", text: "" };

  // Let a picker pause after the decimal point while still keeping the typed
  // value visible. A second decimal place would need an explicit correction;
  // it is never silently rounded.
  if (!/^\d*(?:\.\d*)?$/.test(text)) {
    return {
      kind: "invalid",
      text,
      message: "Use whole kg or one decimal, e.g. 34.3",
    };
  }

  const [wholeText = "", fractionText] = text.split(".");
  if (wholeText === "" && (!fractionText || fractionText.length === 0)) {
    return { kind: "incomplete", text };
  }
  if (fractionText !== undefined && fractionText.length > 1) {
    return {
      kind: "invalid",
      text,
      message: "Use whole kg or one decimal, e.g. 34.3",
    };
  }

  const wholeKg = wholeText === "" ? 0 : Number.parseInt(wholeText, 10);
  const tenths = fractionText && fractionText.length === 1
    ? Number.parseInt(fractionText, 10)
    : 0;
  const kgUnits = wholeKg * 10 + tenths;

  if (!Number.isSafeInteger(kgUnits)) {
    return {
      kind: "invalid",
      text,
      message: "Kg value is too large",
    };
  }

  return { kind: "valid", text, kgUnits };
}

export function formatKgUnits(kgUnits: number): string {
  const wholeKg = Math.trunc(kgUnits / 10);
  const tenths = Math.abs(kgUnits % 10);
  return tenths === 0 ? String(wholeKg) : `${wholeKg}.${tenths}`;
}
