import { useState } from "react";
import { api } from "./api.js";

type IdentityStorageSummary = {
  records: {
    total: number;
    current: number;
    firstRecordedAt: string | null;
    lastRecordedAt: string | null;
    byRecordedDate: Array<{ recorded_date: string; record_count: number }>;
  };
  photos: {
    total: number;
    current: number;
    bytesTotal: number;
    bytesCurrent: number;
  };
};

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.ceil(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

/**
 * Gives the owner a privacy-preserving incident/storage check. The API returns
 * only farm-level totals and dates—never an ID value, worker, image, hash, or
 * other private identity content.
 */
export function IdentitySafetyPanel({ farmId }: { farmId: string }) {
  const [summary, setSummary] = useState<IdentityStorageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function loadSummary() {
    setLoading(true);
    setMessage("");
    try {
      const result = (await api.identityStorageSummary(farmId)) as {
        summary: IdentityStorageSummary;
      };
      setSummary(result.summary);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setLoading(false);
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
      <h3 style={{ marginBottom: 4 }}>Private identity safety &amp; storage</h3>
      <p style={{ margin: "0 0 12px", color: "#4A4A42", fontSize: 12, lineHeight: 1.5 }}>
        Run a privacy-preserving review for this farm. It returns totals and
        recording dates only—never a worker name, ID number, image, hash, or
        encrypted content. Opening this report is recorded in the audit log.
      </p>
      <button className="secondary" disabled={loading} onClick={() => void loadSummary()}>
        {loading ? "Loading aggregate report…" : "Load aggregate-only report"}
      </button>
      {message && (
        <p role="status" style={{ color: "#A04435", fontSize: 12 }}>
          {message}
        </p>
      )}
      {summary && (
        <div
          style={{
            marginTop: 12,
            padding: 13,
            border: "1px solid #D8E2D3",
            borderRadius: 10,
            background: "#F7FBF4",
          }}
        >
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            <div>
              <strong>{summary.records.current}</strong>
              <div style={{ color: "#4A4A42", fontSize: 12 }}>current private ID records</div>
            </div>
            <div>
              <strong>{summary.photos.current}</strong>
              <div style={{ color: "#4A4A42", fontSize: 12 }}>current ID photos</div>
            </div>
            <div>
              <strong>{formatBytes(summary.photos.bytesCurrent)}</strong>
              <div style={{ color: "#4A4A42", fontSize: 12 }}>
                current encrypted photo payload
              </div>
            </div>
            <div>
              <strong>{formatBytes(summary.photos.bytesTotal)}</strong>
              <div style={{ color: "#4A4A42", fontSize: 12 }}>
                all retained encrypted photo payload
              </div>
            </div>
          </div>
          <p style={{ margin: "12px 0 7px", color: "#4A4A42", fontSize: 12, lineHeight: 1.5 }}>
            Identity records retained: {summary.records.total} total / {summary.records.current} current.
            {summary.records.firstRecordedAt
              ? ` First recorded ${new Date(summary.records.firstRecordedAt).toLocaleString()}.`
              : " No identity record has been stored for this farm."}
            {summary.records.lastRecordedAt
              ? ` Most recent ${new Date(summary.records.lastRecordedAt).toLocaleString()}.`
              : ""}
          </p>
          <p style={{ margin: "0 0 8px", color: "#6B6B5E", fontSize: 11, lineHeight: 1.45 }}>
            Superseded records are retained for audit history, so “all retained” can be higher than
            “current”. These are encrypted photo payload bytes (not database row/index overhead) in
            PostgreSQL BYTEA—not a Supabase Storage bucket measurement.
          </p>
          {summary.records.byRecordedDate.length > 0 && (
            <table style={{ marginTop: 8, fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Recording date (EAT)</th>
                  <th>Private records added</th>
                </tr>
              </thead>
              <tbody>
                {summary.records.byRecordedDate.map((day) => (
                  <tr key={day.recorded_date}>
                    <td>{day.recorded_date}</td>
                    <td>{day.record_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
