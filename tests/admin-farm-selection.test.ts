import { describe, expect, it } from "vitest";
import { resolveFarmSelection } from "../apps/admin-web/src/farmSelection.js";

const farms = [
  { farm_id: "11111111-1111-4111-8111-111111111111", name: "TEST-5532" },
  { farm_id: "22222222-2222-4222-8222-222222222222", name: "Second farm" },
];

describe("resolveFarmSelection", () => {
  it("keeps a currently listed farm", () => {
    expect(resolveFarmSelection(farms[1].farm_id, farms)).toBe(farms[1].farm_id);
  });

  it("replaces a stale deleted farm ID with the first current farm", () => {
    expect(resolveFarmSelection("deleted-farm-id", farms)).toBe(farms[0].farm_id);
  });

  it("has no selection when the server reports no farms", () => {
    expect(resolveFarmSelection("deleted-farm-id", [])).toBe("");
  });
});
