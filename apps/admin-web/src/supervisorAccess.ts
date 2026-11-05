export const SUPERVISOR_PASSWORD_MIN_LENGTH = 12;

export type SupervisorProvisioningReadiness = {
  canProvision: boolean;
  needsUsername: boolean;
  passwordCharactersRemaining: number;
};

/**
 * Keeps form readiness explicit: a disabled provision action must always have
 * a safe, non-secret explanation for the Owner. Password content is never
 * inspected or returned—only its length is used locally.
 */
export function supervisorProvisioningReadiness(
  username: string,
  password: string,
  busy = false,
): SupervisorProvisioningReadiness {
  const needsUsername = !username.trim();
  const passwordCharactersRemaining = Math.max(0, SUPERVISOR_PASSWORD_MIN_LENGTH - password.length);
  return {
    canProvision: !busy && !needsUsername && passwordCharactersRemaining === 0,
    needsUsername,
    passwordCharactersRemaining,
  };
}
