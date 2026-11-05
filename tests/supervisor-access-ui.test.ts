import { describe, expect, it } from "vitest";
import {
  SUPERVISOR_PASSWORD_MIN_LENGTH,
  supervisorProvisioningReadiness,
} from "../apps/admin-web/src/supervisorAccess.js";

describe("Supervisor provisioning readiness", () => {
  it("explains that a username is required without allowing submission", () => {
    const readiness = supervisorProvisioningReadiness("   ", "x".repeat(SUPERVISOR_PASSWORD_MIN_LENGTH));
    expect(readiness).toEqual({
      canProvision: false,
      needsUsername: true,
      passwordCharactersRemaining: 0,
    });
  });

  it("keeps provision disabled and reports the remaining password characters", () => {
    const readiness = supervisorProvisioningReadiness("greg", "x".repeat(10));
    expect(readiness).toEqual({
      canProvision: false,
      needsUsername: false,
      passwordCharactersRemaining: 2,
    });
  });

  it("enables provision only for a complete, idle form", () => {
    expect(
      supervisorProvisioningReadiness(
        "greg",
        "x".repeat(SUPERVISOR_PASSWORD_MIN_LENGTH),
      ),
    ).toEqual({
      canProvision: true,
      needsUsername: false,
      passwordCharactersRemaining: 0,
    });
    expect(
      supervisorProvisioningReadiness(
        "greg",
        "x".repeat(SUPERVISOR_PASSWORD_MIN_LENGTH),
        true,
      ).canProvision,
    ).toBe(false);
  });
});
