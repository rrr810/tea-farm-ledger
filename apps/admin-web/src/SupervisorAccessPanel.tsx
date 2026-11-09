import { useEffect, useState } from "react";
import { api } from "./api.js";
import {
  SUPERVISOR_PASSWORD_MIN_LENGTH,
  supervisorProvisioningReadiness,
} from "./supervisorAccess.js";

type SupervisorAccount = {
  user_id: string;
  username: string;
  created_at: string;
  disabled_at?: string | null;
};

type IssuedCredential = {
  username: string;
  password: string;
};

/**
 * Farm-bound Supervisor management. Farm Owners retain manual provisioning;
 * the Master uses server-generated login/password cards that remain only in
 * the current browser memory until dismissed.
 */
export function SupervisorAccessPanel({
  farmId,
  onDone,
  isPlatformAdmin = false,
}: {
  farmId: string;
  onDone: () => void;
  isPlatformAdmin?: boolean;
}) {
  const [accounts, setAccounts] = useState<SupervisorAccount[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [supervisorName, setSupervisorName] = useState("");
  const [resetFor, setResetFor] = useState<SupervisorAccount | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [replaceFor, setReplaceFor] = useState<SupervisorAccount | null>(null);
  const [replacementName, setReplacementName] = useState("");
  const [issuedCredential, setIssuedCredential] = useState<IssuedCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const provisioning = supervisorProvisioningReadiness(username, password, busy);

  async function load() {
    if (!farmId) return;
    try {
      const result = (await api.supervisors(farmId)) as {
        supervisors?: SupervisorAccount[];
      };
      setAccounts(result.supervisors ?? []);
    } catch (error) {
      setMessage(`Could not load Supervisor access: ${String(error)}`);
    }
  }

  useEffect(() => {
    setAccounts([]);
    setUsername("");
    setPassword("");
    setSupervisorName("");
    setResetPassword("");
    setResetFor(null);
    setReplaceFor(null);
    setReplacementName("");
    setIssuedCredential(null);
    setMessage("");
    void load();
  }, [farmId]);

  async function provision() {
    setMessage("");
    setBusy(true);
    try {
      const created = (await api.createSupervisor(farmId, username, password)) as {
        username?: string;
      };
      if (!created.username) throw new Error("Supervisor account returned without a username.");
      setIssuedCredential({ username: created.username, password });
      setUsername("");
      setPassword("");
      setMessage("Supervisor account provisioned. Copy the credential card now.");
      await load();
      onDone();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function generateSupervisor() {
    if (!supervisorName.trim() || busy) return;
    setMessage("");
    setIssuedCredential(null);
    setBusy(true);
    try {
      const created = (await api.generatePlatformSupervisor(farmId, supervisorName)) as {
        username?: string;
        password?: string;
      };
      if (!created.username || !created.password) {
        throw new Error("Supervisor setup returned an incomplete credential card.");
      }
      setIssuedCredential({ username: created.username, password: created.password });
      setSupervisorName("");
      setMessage("Supervisor account generated. Copy the credential card now.");
      await load();
      onDone();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function rotatePassword() {
    if (!resetFor) return;
    setMessage("");
    setBusy(true);
    try {
      await api.resetSupervisorPassword(farmId, resetFor.user_id, resetPassword);
      setIssuedCredential({ username: resetFor.username, password: resetPassword });
      setResetPassword("");
      setMessage(`Password reset for ${resetFor.username}. Copy the new credential card now.`);
      setResetFor(null);
      onDone();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function generateReplacementPassword(account: SupervisorAccount) {
    if (busy) return;
    setMessage("");
    setIssuedCredential(null);
    setBusy(true);
    try {
      const result = (await api.generatePlatformSupervisorPassword(farmId, account.user_id)) as {
        username?: string;
        password?: string;
      };
      if (!result.username || !result.password) {
        throw new Error("Password rotation returned an incomplete credential card.");
      }
      setIssuedCredential({ username: result.username, password: result.password });
      setMessage(`Password reset for ${result.username}. Copy the new credential card now.`);
      onDone();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function replaceSupervisorAccess() {
    if (!replaceFor || !replacementName.trim() || busy) return;
    setMessage("");
    setIssuedCredential(null);
    setBusy(true);
    try {
      const result = (await api.replacePlatformSupervisor(
        farmId,
        replaceFor.user_id,
        replacementName,
      )) as { username?: string; password?: string };
      if (!result.username || !result.password) {
        throw new Error("Supervisor replacement returned an incomplete credential card.");
      }
      setIssuedCredential({ username: result.username, password: result.password });
      setMessage(`Supervisor access replaced. Copy the new credential card now.`);
      setReplaceFor(null);
      setReplacementName("");
      await load();
      onDone();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyCredential() {
    if (!issuedCredential) return;
    try {
      await navigator.clipboard.writeText(
        `Supervisor username: ${issuedCredential.username}\nTemporary password: ${issuedCredential.password}`,
      );
      setMessage("Credentials copied. Share them privately; they are not sent automatically.");
    } catch {
      setMessage("Copy is unavailable in this browser. Select the values and share them privately.");
    }
  }

  return (
    <section
      style={{
        marginTop: 24,
        paddingTop: 20,
        borderTop: "1px solid #D9D1BC",
      }}
    >
      <h3 style={{ marginBottom: 4 }}>Supervisor account access</h3>
      <p style={{ margin: "0 0 13px", color: "#4A4A42", fontSize: 12, lineHeight: 1.5 }}>
        {isPlatformAdmin
          ? "Create, reset, or replace a farm-bound Supervisor with a generated credential card. The Supervisor uses the official farm name plus these details on an empty field phone."
          : "Provision a farm-bound Supervisor account. The Supervisor uses the official farm name plus these credentials once to connect an empty field phone. It also grants short-lived access to private ID tools; daily kg work remains available offline without it."}
      </p>

      {isPlatformAdmin ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            padding: 12,
            border: "1px solid #D8E2D3",
            borderRadius: 10,
            background: "#F7FBF4",
          }}
        >
          <input
            aria-label="New Supervisor name"
            placeholder="Supervisor name — used to suggest login"
            autoCapitalize="words"
            autoComplete="off"
            value={supervisorName}
            disabled={busy}
            onChange={(event) => setSupervisorName(event.target.value)}
            style={{ flex: "1 1 245px", minHeight: 38 }}
          />
          <button
            className="primary"
            disabled={busy || !supervisorName.trim()}
            onClick={() => void generateSupervisor()}
          >
            {busy ? "Generating…" : "Generate Supervisor access"}
          </button>
          <p style={{ width: "100%", margin: 0, color: "#4A4A42", fontSize: 12 }}>
            The suggested username and strong password are shown once. The supplied name is not saved as a separate profile.
          </p>
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
              padding: 12,
              border: "1px solid #D8E2D3",
              borderRadius: 10,
              background: "#F7FBF4",
            }}
          >
            <input
              aria-label="New Supervisor username"
              placeholder="Supervisor username"
              autoCapitalize="none"
              autoComplete="off"
              value={username}
              disabled={busy}
              onChange={(event) => setUsername(event.target.value)}
              style={{ flex: "1 1 165px", minHeight: 38 }}
            />
            <input
              aria-label="New Supervisor password"
              aria-describedby="supervisor-provision-readiness"
              type="password"
              placeholder={`Temporary password (${SUPERVISOR_PASSWORD_MIN_LENGTH}+ characters)`}
              autoComplete="new-password"
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
              style={{ flex: "1 1 220px", minHeight: 38 }}
            />
            <button
              className="primary"
              disabled={!provisioning.canProvision}
              aria-describedby="supervisor-provision-readiness"
              title={
                provisioning.needsUsername
                  ? "Enter a Supervisor username first"
                  : provisioning.passwordCharactersRemaining > 0
                    ? `Add ${provisioning.passwordCharactersRemaining} more password character${provisioning.passwordCharactersRemaining === 1 ? "" : "s"}`
                    : undefined
              }
              onClick={() => void provision()}
            >
              {busy ? "Provisioning…" : "Provision Supervisor"}
            </button>
          </div>
          <p
            id="supervisor-provision-readiness"
            role="status"
            aria-live="polite"
            style={{
              margin: "8px 0 0",
              color: provisioning.canProvision ? "#35653A" : "#6B6B5E",
              fontSize: 12,
            }}
          >
            {busy
              ? "Creating the Supervisor account…"
              : provisioning.needsUsername
                ? "Enter a Supervisor username to enable provisioning."
                : provisioning.passwordCharactersRemaining > 0
                  ? `Password needs ${provisioning.passwordCharactersRemaining} more character${provisioning.passwordCharactersRemaining === 1 ? "" : "s"}; at least ${SUPERVISOR_PASSWORD_MIN_LENGTH} are required.`
                  : `Password meets the ${SUPERVISOR_PASSWORD_MIN_LENGTH}-character minimum. Select Provision Supervisor to continue.`}
          </p>
        </>
      )}

      {issuedCredential && (
        <div className="issued-supervisor-credential" role="status">
          <strong>Copy now — shown once</strong>
          <label>
            Supervisor username
            <input value={issuedCredential.username} readOnly onFocus={(event) => event.currentTarget.select()} />
          </label>
          <label>
            Temporary password
            <input value={issuedCredential.password} readOnly onFocus={(event) => event.currentTarget.select()} />
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="primary" type="button" onClick={() => void copyCredential()}>
              Copy credentials
            </button>
            <button className="secondary" type="button" onClick={() => setIssuedCredential(null)}>
              I copied it — hide password
            </button>
          </div>
        </div>
      )}

      {accounts.length === 0 ? (
        <p style={{ color: "#6B6B5E", fontSize: 12 }}>No Supervisor account has been provisioned for this farm.</p>
      ) : (
        <table style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>Supervisor username</th>
              <th>Provisioned</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => {
              const active = !account.disabled_at;
              return (
                <tr key={account.user_id}>
                  <td>{account.username}</td>
                  <td style={{ fontSize: 12 }}>
                    {new Date(account.created_at).toLocaleString()}
                  </td>
                  <td style={{ fontSize: 12, color: active ? "#35653A" : "#6B6B5E" }}>
                    {active ? "Active" : "Access replaced"}
                  </td>
                  <td style={{ textAlign: "right", display: "flex", gap: 7, justifyContent: "flex-end", flexWrap: "wrap" }}>
                    {active && (
                      <>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => {
                            if (isPlatformAdmin) {
                              void generateReplacementPassword(account);
                            } else {
                              setResetFor(account);
                              setResetPassword("");
                              setMessage("");
                            }
                          }}
                        >
                          {isPlatformAdmin ? "Generate fresh password" : "Reset password"}
                        </button>
                        {isPlatformAdmin && (
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => {
                              setReplaceFor(account);
                              setReplacementName("");
                              setMessage("");
                            }}
                          >
                            Replace access
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {isPlatformAdmin && replaceFor && (
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            marginTop: 11,
            padding: 11,
            border: "1px solid #E1CEAA",
            borderRadius: 10,
            background: "#FFF9EC",
          }}
        >
          <strong style={{ width: "100%", fontSize: 13 }}>
            Replace access for {replaceFor.username}
          </strong>
          <p style={{ width: "100%", margin: 0, color: "#4A4A42", fontSize: 12, lineHeight: 1.45 }}>
            The former Supervisor will lose sign-in, private-ID sessions, unused pairing codes, and devices enrolled under their account. A new credential is shown once.
          </p>
          <input
            aria-label="Replacement Supervisor name"
            placeholder="Replacement Supervisor name"
            autoCapitalize="words"
            autoComplete="off"
            value={replacementName}
            disabled={busy}
            onChange={(event) => setReplacementName(event.target.value)}
            style={{ flex: "1 1 220px", minHeight: 38 }}
          />
          <button
            className="primary"
            disabled={busy || !replacementName.trim()}
            onClick={() => void replaceSupervisorAccess()}
          >
            {busy ? "Replacing…" : "Replace and generate access"}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setReplaceFor(null);
              setReplacementName("");
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {!isPlatformAdmin && resetFor && (
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            marginTop: 11,
            padding: 11,
            border: "1px solid #E1CEAA",
            borderRadius: 10,
            background: "#FFF9EC",
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700 }}>
            New password for {resetFor.username}
          </span>
          <input
            aria-label={`New password for ${resetFor.username}`}
            type="password"
            placeholder="New password (12+ characters)"
            autoComplete="new-password"
            value={resetPassword}
            disabled={busy}
            onChange={(event) => setResetPassword(event.target.value)}
            style={{ flex: "1 1 220px", minHeight: 38 }}
          />
          <button
            className="primary"
            disabled={busy || resetPassword.length < 12}
            onClick={() => void rotatePassword()}
          >
            Save reset
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setResetFor(null);
              setResetPassword("");
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {message && (
        <p role="status" style={{ marginBottom: 0, color: message.startsWith("Could") || /^\d/.test(message) ? "#A04435" : "#35653A", fontSize: 12 }}>
          {message}
        </p>
      )}
    </section>
  );
}
