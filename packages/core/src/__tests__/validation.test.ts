import { describe, it, expect } from "vitest";
import { validateKgTenths, validateWorkerName } from "../validation.js";
import { normalizeNationalIdNumber } from "../identity.js";
describe("validation", () => {
  it("kg validation", () => { expect(validateKgTenths(500).valid).toBe(true); expect(validateKgTenths(-1).valid).toBe(false); expect(validateKgTenths(601).valid).toBe(false); expect(validateKgTenths(60.5).valid).toBe(false); });
  it("name", () => { expect(validateWorkerName("Jane").valid).toBe(true); expect(validateWorkerName("").valid).toBe(false); });
  it("normalizes a numeric national ID without accepting phone-like punctuation", () => {
    expect(normalizeNationalIdNumber("  12 345 678 ")).toEqual({ ok: true, value: "12345678" });
    expect(normalizeNationalIdNumber("+254 712 345 678").ok).toBe(false);
    expect(normalizeNationalIdNumber("123").ok).toBe(false);
  });
});
