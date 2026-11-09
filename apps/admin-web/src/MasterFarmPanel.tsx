import { useState } from "react";
import { api } from "./api.js";

type Farm = { farm_id: string; name: string };
type CredentialCard = {
  farmName: string;
  username: string;
  password: string;
};

/**
 * Central new-farm provisioning. The server creates the password with secure
 * randomness and returns it once in this response; it is deliberately held
 * only in this component's memory until the Master copies or dismisses it.
 */
export function MasterFarmPanel({
  farms,
  onCreated,
  onOpenFarm,
}: {
  farms: Farm[];
  onCreated: (farm: Farm) => void;
  onOpenFarm: (farmId: string) => void;
}) {
  const [farmName, setFarmName] = useState("");
  const [supervisorName, setSupervisorName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [credential, setCredential] = useState<CredentialCard | null>(null);

  async function createFarm() {
    if (busy) return;
    setMessage("");
    setCredential(null);
    setBusy(true);
    try {
      const result = (await api.createPlatformFarm(farmName, supervisorName)) as {
        farm_id?: string;
        name?: string;
        supervisor?: { username?: string; password?: string };
      };
      if (
        !result.farm_id ||
        !result.name ||
        !result.supervisor?.username ||
        !result.supervisor.password
      ) {
        throw new Error("Farm setup returned an incomplete credential card. No credentials were retained.");
      }
      const created = { farm_id: result.farm_id, name: result.name };
      setCredential({
        farmName: result.name,
        username: result.supervisor.username,
        password: result.supervisor.password,
      });
      setFarmName("");
      setSupervisorName("");
      onCreated(created);
      setMessage("Farm created. Copy the Supervisor sign-in details now.");
    } catch (error) {
      setMessage(String((error as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function copyCredential() {
    if (!credential) return;
    const text = [
      "Tea Ledger field-phone sign-in",
      `Farm: ${credential.farmName}`,
      `Supervisor username: ${credential.username}`,
      `Temporary password: ${credential.password}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setMessage("Credentials copied. Send them privately to the Supervisor; they are not sent automatically.");
    } catch {
      setMessage("Copy is unavailable in this browser. Select the credential values and share them privately.");
    }
  }

  return (
    <>
      <section className="card master-farm-create">
        <div className="admin-dashboard-kicker" style={{ color: "#b86f36" }}>
          Master Admin
        </div>
        <h3>Create a new farm</h3>
        <p className="muted" style={{ maxWidth: 720 }}>
          Create the official farm and its first field Supervisor together. The Supervisor’s
          name is used only to suggest a private login name; it is not kept as a separate
          profile record here. A strong password is generated automatically and shown once.
        </p>
        <div className="master-farm-create-fields">
          <label>
            Official farm name
            <input
              aria-label="Official farm name"
              autoCapitalize="words"
              autoComplete="organization"
              placeholder="e.g. Green Hills Tea Farm"
              maxLength={80}
              value={farmName}
              disabled={busy}
              onChange={(event) => setFarmName(event.target.value)}
            />
          </label>
          <label>
            First Supervisor name
            <input
              aria-label="First Supervisor name"
              autoCapitalize="words"
              autoComplete="off"
              placeholder="Name used to suggest a login"
              maxLength={80}
              value={supervisorName}
              disabled={busy}
              onChange={(event) => setSupervisorName(event.target.value)}
            />
          </label>
          <button
            className="primary"
            type="button"
            disabled={busy || !farmName.trim() || !supervisorName.trim()}
            onClick={() => void createFarm()}
          >
            {busy ? "Creating farm…" : "Create farm & generate Supervisor access"}
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          New farms start at KES 9 per kg. No SMS, email, or payment is sent by this action.
        </p>
      </section>

      {credential && (
        <section className="card master-credential-card" aria-live="polite">
          <div className="admin-dashboard-kicker" style={{ color: "#b86f36" }}>
            Copy now — shown once
          </div>
          <h3>Supervisor field-phone sign-in</h3>
          <p className="muted">
            Give these details privately to the person using the empty field phone. The
            password is not saved in the console and will not be shown again after you close this card.
          </p>
          <div className="master-credential-grid">
            <label>
              Official farm
              <input value={credential.farmName} readOnly onFocus={(event) => event.currentTarget.select()} />
            </label>
            <label>
              Supervisor username
              <input value={credential.username} readOnly onFocus={(event) => event.currentTarget.select()} />
            </label>
            <label>
              Temporary password
              <input value={credential.password} readOnly onFocus={(event) => event.currentTarget.select()} />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button className="primary" type="button" onClick={() => void copyCredential()}>
              Copy sign-in details
            </button>
            <button className="secondary" type="button" onClick={() => setCredential(null)}>
              I copied it — hide password
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <div className="admin-dashboard-kicker" style={{ color: "#b86f36" }}>
          Central portfolio
        </div>
        <h3>Your farms</h3>
        {farms.length === 0 ? (
          <p className="muted">No farms yet. Use the secure form above to create the first one.</p>
        ) : (
          <div className="master-farm-list">
            {farms.map((farm) => (
              <div key={farm.farm_id} className="master-farm-row">
                <div>
                  <strong>{farm.name}</strong>
                  <span>Official farm record</span>
                </div>
                <button className="secondary" type="button" onClick={() => onOpenFarm(farm.farm_id)}>
                  Open farm console
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {message && (
        <p
          role="status"
          className="master-farm-message"
          style={{ color: /^\d/.test(message) || message.includes("Error") ? "#A04435" : "#35653A" }}
        >
          {message}
        </p>
      )}
    </>
  );
}
