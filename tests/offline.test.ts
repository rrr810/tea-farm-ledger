import { describe, it, expect } from "vitest";
import { isGsm7, countSegments } from "@tea-ledger/core";
describe("offline flags", () => {
  it("pending upload wording", () => {
    const msg = "Saturday entry not received by server, please connect to sync.";
    expect(isGsm7(msg)).toBe(true); expect(countSegments(msg)).toBe(1); expect(msg).toBe("Saturday entry not received by server, please connect to sync.");
  });
});
