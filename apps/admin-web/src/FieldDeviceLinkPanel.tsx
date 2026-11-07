import { useState } from "react";
import { api } from "./api.js";

type LinkCodeResponse = {
  code?: string;
  expires_at?: string;
  expires_in_seconds?: number;
};

/**
 * Generates a single-use pairing secret for an otherwise empty field browser.
 * It never reveals a farm ID and never stores the plaintext code in the Admin
 * app after the owner closes or refreshes this panel.
 */
export function FieldDeviceLinkPanel({ farmId }: { farmId: string }) {
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [message, setMessage] = useState("");

  async function generate() {
    setBusy(true);
    setMessage("");
    setCode("");
    setExpiresAt("");
    try {
      const result = (await api.createFieldDeviceLinkCode(farmId)) as LinkCodeResponse;
      if (!result.code || !result.expires_at) {
        throw new Error("The link code could not be created. Try again.");
      }
      setCode(result.code);
      setExpiresAt(result.expires_at);
      setMessage("Give this code privately to the person holding the empty field device.");
    } catch (error) {
      setMessage(`Could not create a field-device link code: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setMessage("Link code copied. It remains valid only until its displayed expiry or first use.");
    } catch {
      setMessage("Copy is unavailable in this browser. Select the code and share it privately.");
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
      <h3 style={{ marginBottom: 4 }}>Link an empty field device</h3>
      <p style={{ margin: "0 0 13px", color: "#4A4A42", fontSize: 12, lineHeight: 1.5 }}>
        Use this only when the field phone has no daily records or pending sync. It gives one empty
        browser a fresh device credential for this farm. It does not move workers, kg, payroll,
        SMS settings, or any record between farms.
      </p>
      <button className="secondary" disabled={busy} onClick={() => void generate()}>
        {busy ? "Creating one-time code…" : "Generate 10-minute link code"}
      </button>

      {code && (
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            marginTop: 12,
            padding: 12,
            border: "1px solid #D8E2D3",
            borderRadius: 10,
            background: "#F7FBF4",
          }}
        >
          <input
            aria-label="One-time field-device link code"
            value={code}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
            style={{ flex: "1 1 290px", minHeight: 38, fontFamily: "monospace", letterSpacing: 0.3 }}
          />
          <button className="primary" onClick={() => void copyCode()}>
            Copy code
          </button>
          <p style={{ width: "100%", margin: 0, color: "#4A4A42", fontSize: 12 }}>
            One use only · expires {new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {" · "}do not send it in a public group.
          </p>
        </div>
      )}
      {message && (
        <p
          role="status"
          style={{
            marginBottom: 0,
            color: message.startsWith("Could") ? "#A04435" : "#35653A",
            fontSize: 12,
          }}
        >
          {message}
        </p>
      )}
    </section>
  );
}
