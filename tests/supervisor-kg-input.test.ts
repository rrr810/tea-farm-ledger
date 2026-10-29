import { describe, expect, it } from "vitest";
import {
  formatKgUnits,
  parseKgInput,
} from "../apps/supervisor-pwa/src/kgInput.js";

describe("Supervisor kg input", () => {
  it("stores a decimal kg value as integer tenths without floating point", () => {
    expect(parseKgInput("34.3")).toEqual({
      kind: "valid",
      text: "34.3",
      kgUnits: 343,
    });
    expect(parseKgInput("0.5")).toEqual({
      kind: "valid",
      text: "0.5",
      kgUnits: 5,
    });
    expect(parseKgInput("34")).toEqual({
      kind: "valid",
      text: "34",
      kgUnits: 340,
    });
  });

  it("keeps a single decimal point usable while a picker is typing", () => {
    expect(parseKgInput("34.")).toEqual({
      kind: "valid",
      text: "34.",
      kgUnits: 340,
    });
    expect(parseKgInput(".")).toEqual({ kind: "incomplete", text: "." });
    expect(parseKgInput(".5")).toEqual({
      kind: "valid",
      text: ".5",
      kgUnits: 5,
    });
  });

  it("accepts a decimal comma but never silently rounds extra precision", () => {
    expect(parseKgInput("34,3")).toEqual({
      kind: "valid",
      text: "34.3",
      kgUnits: 343,
    });
    expect(parseKgInput("34.35")).toMatchObject({
      kind: "invalid",
      message: "Use whole kg or one decimal, e.g. 34.3",
    });
  });

  it("formats stored integer tenths for a readable input", () => {
    expect(formatKgUnits(343)).toBe("34.3");
    expect(formatKgUnits(340)).toBe("34");
    expect(formatKgUnits(5)).toBe("0.5");
  });
});
