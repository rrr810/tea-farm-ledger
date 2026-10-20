import { describe, it, expect } from "vitest";
import { normalizeKePhone, maskPhone } from "../phone.js";
describe("normalizeKePhone", () => {
  it("normalizes 07 -> +254", () => { expect(normalizeKePhone("0712345678")).toEqual({ ok: true, e164: "+254712345678" }); });
  it("normalizes 01 -> +254", () => { expect(normalizeKePhone("0112345678")).toEqual({ ok: true, e164: "+254112345678" }); });
  it("handles 254 prefix", () => { expect(normalizeKePhone("254712345678")).toEqual({ ok: true, e164: "+254712345678" }); });
  it("keeps +254", () => { expect(normalizeKePhone("+254712345678")).toEqual({ ok: true, e164: "+254712345678" }); });
  it("handles 7 without 0", () => { expect(normalizeKePhone("712345678")).toEqual({ ok: true, e164: "+254712345678" }); });
  it("rejects invalid", () => { expect(normalizeKePhone("123").ok).toBe(false); expect(normalizeKePhone("").ok).toBe(false); });
  it("trims and strips spaces/dashes", () => { expect(normalizeKePhone(" 0712 345 678 ")).toEqual({ ok: true, e164: "+254712345678" }); });
});
describe("maskPhone", () => { it("masks correctly", () => { expect(maskPhone("+254712345678")).toBe("+2547***5678"); }); });
