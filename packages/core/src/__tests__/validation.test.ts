import { describe, it, expect } from "vitest";
import { validateKgTenths, validateWorkerName } from "../validation.js";
describe("validation", () => {
  it("kg validation", () => { expect(validateKgTenths(500).valid).toBe(true); expect(validateKgTenths(-1).valid).toBe(false); expect(validateKgTenths(601).valid).toBe(false); expect(validateKgTenths(60.5).valid).toBe(false); });
  it("name", () => { expect(validateWorkerName("Jane").valid).toBe(true); expect(validateWorkerName("").valid).toBe(false); });
});
