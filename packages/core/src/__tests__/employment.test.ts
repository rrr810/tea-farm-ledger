import { describe, it, expect } from "vitest";
import { isActiveOn, getActivePeriod, canHire, canFire, canReusePhone } from "../employment.js";
describe("employment inclusive", () => {
  const p1 = { id: "1", worker_id: "w1", farm_id: "f1", start_date: "2026-11-01", end_date: "2026-11-15", end_reason: "quit" };
  const p2 = { id: "2", worker_id: "w1", farm_id: "f1", start_date: "2026-11-20", end_date: null };
  it("inclusive", () => {
    expect(isActiveOn(p1, "2026-11-01")).toBe(true);
    expect(isActiveOn(p1, "2026-11-15")).toBe(true);
    expect(isActiveOn(p1, "2026-11-16")).toBe(false);
    expect(isActiveOn(p2, "2026-11-20")).toBe(true);
  });
  it("getActive", () => {
    expect(getActivePeriod([p1,p2], "2026-11-10")?.id).toBe("1");
    expect(getActivePeriod([p1,p2], "2026-11-22")?.id).toBe("2");
    expect(getActivePeriod([p1,p2], "2026-11-18")).toBe(null);
  });
  it("canHire", () => {
    expect(canHire([p1], "2026-11-16").ok).toBe(true);
    expect(canHire([p1], "2026-11-15").ok).toBe(false); // inclusive overlap
    expect(canHire([p2], "2026-11-30").ok).toBe(false); // already active
  });
  it("canFire", () => {
    expect(canFire([p1], "2026-11-15").ok).toBe(false); // p1 not active (ended)
    expect(canFire([p2], "2026-11-25").ok).toBe(true);
    expect(canFire([p2], "2026-10-01").ok).toBe(false);
  });
  it("phone reuse", () => {
    const workers = [{ worker_id: "w1", phone_e164: "+254712345678", status: "active" }, { worker_id: "w2", phone_e164: "+254712345678", status: "inactive" }];
    expect(canReusePhone("+254712345678", workers as any, "w3").ok).toBe(false);
    expect(canReusePhone("+254712345678", [{ worker_id: "w1", phone_e164: "+254712345678", status: "inactive" } as any], "w3").ok).toBe(true);
  });
});
