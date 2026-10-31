import { useEffect, useState } from "react";
import { api } from "./api.js";

type SupervisorAccount = {
  user_id: string;
  username: string;
  created_at: string;
};

/**
 * Admin-only credential management. Password values live only in the form
 * state until submitted and are never rendered back from the API.
 */
export function SupervisorAccessPanel({
  farmId,
  onDone,
}: {
  farmId: string;
  onDone: () => void;
}) {
  const [accounts, setAccounts] = useState<SupervisorAccount[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [resetFor, setResetFor] = useState<SupervisorAccount | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

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
    setPassword("");
    setResetPassword("");
    setResetFor(null);
    setMessage("");
    void load();
  }, [farmId]);

  async function provision() {
    setMessage("");
    setBusy(true);
    try {
      await api.createSupervisor(farmId, username, password);
      setUsername("");
      setPassword("");
      setMessage("Supervisor account provisioned. Share the password privately.");
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
      setResetPassword("");
      setMessage(`Password reset for ${resetFor.username}; prior private-ID sessions were signed out.`);
      setResetFor(null);
      onDone();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
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
      <h3 style={{ marginBottom: 4 }}>Supervisor private-ID access</h3>
      <p style={{ margin: "0 0 13px", color: "#4A4A42", fontSize: 12, lineHeight: 1.5 }}>
        Provision a farm-bound field account for the Nandi Supervisor. This grants
        short-lived access only to record private ID details; daily kg work remains
        available offline without it. Use a unique password of at least 12 characters.
      </p>

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
          type="password"
          placeholder="Temporary password (12+ characters)"
          autoComplete="new-password"
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
          style={{ flex: "1 1 220px", minHeight: 38 }}
        />
        <button
          className="primary"
          disabled={busy || !username.trim() || password.length < 12}
          onClick={() => void provision()}
        >
          Provision Supervisor
        </button>
      </div>

      {accounts.length === 0 ? (
        <p style={{ color: "#6B6B5E", fontSize: 12 }}>No Supervisor account has been provisioned for this farm.</p>
      ) : (
        <table style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>Supervisor username</th>
              <th>Provisioned</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.user_id}>
                <td>{account.username}</td>
                <td style={{ fontSize: 12 }}>
                  {new Date(account.created_at).toLocaleString()}
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setResetFor(account);
                      setResetPassword("");
                      setMessage("");
                    }}
                  >
                    Reset password
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {resetFor && (
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
