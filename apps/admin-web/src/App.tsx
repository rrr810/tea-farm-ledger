import { useEffect, useState } from "react";
import {
  ADMIN_SESSION_EXPIRED_EVENT,
  api,
  clearAdminSession,
  farmId,
  setFarmId,
  setToken,
  token,
} from "./api.js";
import { resolveFarmSelection } from "./farmSelection.js";
import { currentWeekStartEAT } from "./week.js";
import { SupervisorAccessPanel } from "./SupervisorAccessPanel.js";
import { IdentitySafetyPanel } from "./IdentitySafetyPanel.js";
import { FieldDeviceLinkPanel } from "./FieldDeviceLinkPanel.js";
import { MasterFarmPanel } from "./MasterFarmPanel.js";

type Tab =
  | "login"
  | "farms"
  | "dashboard"
  | "workers"
  | "payroll"
  | "conflicts"
  | "sms"
  | "reports"
  | "import"
  | "settings"
  | "audit";
type PayrollLine = {
  name: string;
  totalKg: number;
  amountKes: number;
  flags: string[];
  maskedPhone: string;
  daysWorked: number;
};
type PayrollSheetResponse = {
  sheet: {
    weekStart: string;
    weekEnd: string;
    status: string;
    lines: PayrollLine[];
    totals: { totalKg: number; totalAmountKes: number };
  };
};

type WorkerProfileSummary = {
  worker_id: string;
  farm_id: string;
  full_name: string;
  phone_e164: string | null;
  status: string;
  verified: boolean;
  created_at: string;
  has_identity: boolean;
  has_id_photo: boolean;
  identity_recorded_at: string | null;
};

type WorkerProfile = WorkerProfileSummary & {
  national_id_number: string | null;
  identity_consent_at: string | null;
  identity_consent_author: string | null;
  id_photo: {
    content_type: string;
    byte_size: number;
    captured_at: string;
  } | null;
};

// ---- reporting helpers (quarter math + lightweight SVG charts, no deps) ----
function quarterLabel(d = new Date()): string {
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}
function lastQuarters(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(quarterLabel(d));
    d.setMonth(d.getMonth() - 3);
  }
  return out;
}
function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div
      style={{
        background: "#FFFDF6",
        border: "1px solid #D9D2BC",
        borderRadius: 12,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: 0.8,
          textTransform: "uppercase",
          color: "#4A4A42",
          fontWeight: 700,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: 20,
          fontWeight: 700,
          color: "#1F4D2B",
          margin: "4px 0 2px",
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: "#6B6B5E" }}>{sub}</div>}
    </div>
  );
}
function BarChart({
  data,
  color,
}: {
  data: Array<{ label: string; value: number }>;
  color: string;
}) {
  if (data.length === 0)
    return <p style={{ fontSize: 12, color: "#6B6B5E" }}>No data yet.</p>;
  const w = 560,
    h = 190,
    pad = 30;
  const max = Math.max(1, ...data.map((d) => d.value));
  const slot = (w - pad * 2) / data.length;
  const bw = Math.min(56, slot - 10);
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: "100%", maxWidth: 640, display: "block" }}
      role="img"
    >
      <line
        x1={pad}
        y1={h - pad}
        x2={w - pad}
        y2={h - pad}
        stroke="#D9D2BC"
        strokeWidth="1.5"
      />
      {data.map((d, i) => {
        const bh = Math.max(2, Math.round(((h - pad * 2) * d.value) / max));
        const x = pad + i * slot + (slot - bw) / 2;
        const y = h - pad - bh;
        return (
          <g key={d.label}>
            <rect x={x} y={y} width={bw} height={bh} rx="6" fill={color} />
            <text
              x={x + bw / 2}
              y={y - 6}
              textAnchor="middle"
              fontSize="11"
              fontWeight={700}
              fill="#23231F"
            >
              {d.value.toLocaleString()}
            </text>
            <text
              x={x + bw / 2}
              y={h - pad + 15}
              textAnchor="middle"
              fontSize="11"
              fill="#4A4A42"
            >
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function WeekPayTable({
  title,
  data,
  live,
}: {
  title: string;
  data: PayrollSheetResponse | null;
  live?: boolean;
}) {
  const sheet = data?.sheet;
  return (
    <section className="week-pay-card">
      <div className="week-pay-heading">
        <div>
          <h3>{title}</h3>
          {sheet ? (
            <p className="muted">
              {sheet.weekStart} to {sheet.weekEnd} ·{" "}
              {sheet.status === "locked"
                ? "Final locked record"
                : "Live estimate from synced entries"}
            </p>
          ) : (
            <p className="muted">Loading payroll data…</p>
          )}
        </div>
        {live && <span className="pill">LIVE</span>}
      </div>
      {sheet ? (
        <>
          <div className="week-totals">
            <div>
              <span>Farm total</span>
              <strong>{sheet.totals.totalKg.toFixed(1)} kg</strong>
            </div>
            <div>
              <span>
                {sheet.status === "locked" ? "Final payroll" : "Estimated pay"}
              </span>
              <strong>
                KES {sheet.totals.totalAmountKes.toLocaleString()}
              </strong>
            </div>
            <div>
              <span>Workers</span>
              <strong>{sheet.lines.length}</strong>
            </div>
          </div>
          {sheet.lines.length === 0 ? (
            <p className="muted empty-copy">
              No synced plucking entries for this week yet.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="week-pay-table">
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th>Days</th>
                    <th>Kg</th>
                    <th>
                      {sheet.status === "locked"
                        ? "Final salary"
                        : "Estimated salary"}
                    </th>
                    <th>Checks</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.lines.map((line) => (
                    <tr key={`${sheet.weekStart}-${line.name}`}>
                      <td>{line.name}</td>
                      <td>{line.daysWorked}</td>
                      <td>{line.totalKg.toFixed(1)}</td>
                      <td>KES {line.amountKes.toLocaleString()}</td>
                      <td>{line.flags.length ? line.flags.join(", ") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>(token() ? "dashboard" : "login");
  const [msg, setMsg] = useState("");

  // Password values live only in this component until submitted; they are
  // never written to browser storage. The Master account is a separate,
  // cross-farm identity; retained farm Owners still use their old sign-in.
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [showFarmOwnerLogin, setShowFarmOwnerLogin] = useState(false);
  const [masterEmail, setMasterEmail] = useState("");
  const [masterPassword, setMasterPassword] = useState("");
  const [masterLoginBusy, setMasterLoginBusy] = useState(false);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [activationStatus, setActivationStatus] = useState<{
    master_active: boolean;
    can_activate: boolean;
  } | null>(null);
  const [activationEmail, setActivationEmail] = useState("");
  const [activationPassword, setActivationPassword] = useState("");
  const [activationPasswordRepeat, setActivationPasswordRepeat] = useState("");
  const [activationBusy, setActivationBusy] = useState(false);
  const [activationMessage, setActivationMessage] = useState("");
  const [farms, setFarms] = useState<Array<{ farm_id: string; name: string }>>(
    [],
  );
  const [currentFarm, setCurrentFarm] = useState(farmId());

  // data
  const [workers, setWorkers] = useState<WorkerProfileSummary[]>([]);
  const [selectedWorkerProfile, setSelectedWorkerProfile] =
    useState<WorkerProfile | null>(null);
  const [workerProfileLoading, setWorkerProfileLoading] = useState(false);
  const [workerIdPhotoUrl, setWorkerIdPhotoUrl] = useState<string | null>(null);
  const [payrollWeeks, setPayrollWeeks] = useState<unknown[]>([]);
  const [payrollSheet, setPayrollSheet] = useState<PayrollSheetResponse | null>(
    null,
  );
  const [currentWeekSheet, setCurrentWeekSheet] =
    useState<PayrollSheetResponse | null>(null);
  const [latestLockedSheet, setLatestLockedSheet] =
    useState<PayrollSheetResponse | null>(null);
  const [dashboardLoadedAt, setDashboardLoadedAt] = useState<string | null>(
    null,
  );
  const [weekStart, setWeekStart] = useState(() => currentWeekStartEAT());
  const [conflicts, setConflicts] = useState<unknown[]>([]);
  const [corrections, setCorrections] = useState<unknown[]>([]);
  const [smsLog, setSmsLog] = useState<unknown[]>([]);
  const [smsRefreshing, setSmsRefreshing] = useState(false);
  const [smsTestReadiness, setSmsTestReadiness] = useState<{
    ready: boolean;
    reason: string | null;
  } | null>(null);
  const [smsTestSending, setSmsTestSending] = useState(false);
  const [monthly, setMonthly] = useState<unknown[]>([]);
  const [hardest, setHardest] = useState<unknown[]>([]);
  const [quarter, setQuarter] = useState(() => quarterLabel());
  const [audit, setAudit] = useState<unknown[]>([]);
  const [rates, setRates] = useState<unknown[]>([]);
  const [csvText, setCsvText] = useState(
    "worker_id,full_name,phone_e164,business_date,kg_units,present,is_plucking_day\n",
  );
  const [csvPreview, setCsvPreview] = useState<unknown>(null);

  function toast(m: string) {
    setMsg(m);
    setTimeout(() => setMsg(""), 4000);
  }

  async function doLogin() {
    try {
      const res = (await api.login(username, password)) as {
        token: string;
        farm_id: string;
      };
      setToken(res.token);
      setFarmId(res.farm_id);
      setCurrentFarm(res.farm_id);
      setIsPlatformAdmin(false);
      setActivationStatus(null);
      setTab("dashboard");
      toast("Logged in");
      void loadFarms();
    } catch (e) {
      toast(String(e));
    }
  }

  async function doMasterLogin() {
    if (masterLoginBusy) return;
    setMasterLoginBusy(true);
    try {
      const result = (await api.platformLogin(masterEmail, masterPassword)) as {
        token?: string;
        email?: string;
      };
      if (!result.token) throw new Error("Master sign-in returned an incomplete session.");
      setToken(result.token);
      localStorage.removeItem("farm_id");
      setCurrentFarm("");
      setIsPlatformAdmin(true);
      setActivationStatus(null);
      setMasterPassword("");
      setTab("farms");
      toast("Master Console opened");
      await loadFarms();
    } catch (error) {
      toast(String((error as Error).message));
    } finally {
      setMasterLoginBusy(false);
    }
  }

  async function activateMasterAdmin() {
    if (activationBusy) return;
    setActivationMessage("");
    if (!activationEmail.trim() || !activationPassword) {
      setActivationMessage("Enter your email address and a Master password.");
      return;
    }
    if (activationPassword !== activationPasswordRepeat) {
      setActivationMessage("The Master passwords do not match.");
      return;
    }
    setActivationBusy(true);
    try {
      const result = (await api.activatePlatformAdmin(activationEmail, activationPassword)) as {
        token?: string;
      };
      if (!result.token) throw new Error("Master activation returned an incomplete session.");
      setToken(result.token);
      localStorage.removeItem("farm_id");
      setCurrentFarm("");
      setIsPlatformAdmin(true);
      setActivationStatus({ master_active: true, can_activate: false });
      setActivationEmail("");
      setActivationPassword("");
      setActivationPasswordRepeat("");
      setTab("farms");
      toast("Master Console activated");
      await loadFarms();
    } catch (error) {
      setActivationMessage(String((error as Error).message));
    } finally {
      setActivationBusy(false);
    }
  }

  async function loadFarms() {
    try {
      const [farmResult, session] = await Promise.all([
        api.farms() as Promise<{ farms: Array<{ farm_id: string; name: string }> }>,
        api.me() as Promise<{ farm_id: string | null; role: string }>,
      ]);
      const master = session.role === "platform_admin";
      setIsPlatformAdmin(master);
      // Retained farm Owners stay limited to their own farm. The Master sees
      // the deliberate all-farm list from the central console.
      const allowedFarms = master
        ? farmResult.farms
        : farmResult.farms.filter((farm) => farm.farm_id === session.farm_id);
      setFarms(allowedFarms);
      const nextFarm = resolveFarmSelection(currentFarm, allowedFarms);
      if (nextFarm !== currentFarm) {
        setCurrentFarm(nextFarm);
        if (nextFarm) setFarmId(nextFarm);
        else localStorage.removeItem("farm_id");
      }
      if (master) {
        setActivationStatus(null);
        if (!nextFarm) setTab("farms");
      } else {
        try {
          const status = (await api.platformActivationStatus()) as {
            master_active: boolean;
            can_activate: boolean;
          };
          setActivationStatus(status);
        } catch {
          // A retained Owner who is not the trusted bootstrap identity must not
          // learn extra setup detail. The activation panel simply stays hidden.
          setActivationStatus(null);
        }
      }
    } catch (e) {
      // Before login there is no session yet; the login flow calls this again.
      console.error(e);
    }
  }

  async function loadDashboard() {
    if (!currentFarm) return;
    setCurrentWeekSheet(null);
    setLatestLockedSheet(null);
    setDashboardLoadedAt(null);
    try {
      const liveWeekStart = currentWeekStartEAT();
      const [w, pw, cf, cr, sms, smsTest, mon, hard, au, ra, liveSheet] =
        await Promise.all([
          api.adminWorkers(currentFarm) as Promise<{ workers: WorkerProfileSummary[] }>,
          api.payrollWeeks(currentFarm) as Promise<{ weeks: unknown[] }>,
          api.conflicts(currentFarm) as Promise<{ conflicts: unknown[] }>,
          api.corrections(currentFarm) as Promise<{ corrections: unknown[] }>,
          api.smsLog(currentFarm) as Promise<{ messages: unknown[] }>,
          api.smsTestReadiness(currentFarm) as Promise<{ ready: boolean; reason: string | null }>,
          api.monthly(currentFarm) as Promise<{ monthly: unknown[] }>,
          api.hardest(currentFarm, quarter) as Promise<{ ranking: unknown[] }>,
          api.auditLog(currentFarm) as Promise<{ logs: unknown[] }>,
          api.rates(currentFarm) as Promise<{ rates: unknown[] }>,
          api.payroll(
            currentFarm,
            liveWeekStart,
          ) as Promise<PayrollSheetResponse>,
        ]);
      const weeks = pw.weeks ?? [];
      const latestLocked = (
        weeks as Array<{ week_start: string; status: string }>
      )
        .filter((week) => week.status === "locked")
        .sort((a, b) => b.week_start.localeCompare(a.week_start))[0];
      const lockedSheet = latestLocked
        ? ((await api.payroll(
            currentFarm,
            latestLocked.week_start,
          )) as PayrollSheetResponse)
        : null;
      setWorkers(w.workers ?? []);
      setPayrollWeeks(weeks);
      setConflicts(cf.conflicts ?? []);
      setCorrections(cr.corrections ?? []);
      setSmsLog(sms.messages ?? []);
      setSmsTestReadiness(smsTest);
      setMonthly(mon.monthly ?? []);
      setHardest(hard.ranking ?? []);
      setAudit(au.logs ?? []);
      setRates(ra.rates ?? []);
      setCurrentWeekSheet(liveSheet);
      setLatestLockedSheet(lockedSheet);
      setDashboardLoadedAt(new Date().toLocaleTimeString());
    } catch (e) {
      toast(String(e));
    }
  }

  useEffect(() => {
    if (currentFarm) loadDashboard();
  }, [currentFarm, tab, quarter]);
  useEffect(() => {
    // A profile belongs to one farm; never keep it visible while the selected
    // farm changes, even briefly.
    setSelectedWorkerProfile(null);
    setWorkerIdPhotoUrl(null);
    setSmsTestReadiness(null);
  }, [currentFarm]);
  useEffect(() => {
    const returnToLogin = () => {
      logout("Your admin session expired. Sign in again.");
    };
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, returnToLogin);
    return () => window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, returnToLogin);
  }, []);
  useEffect(() => {
    loadFarms();
  }, []);
  useEffect(() => {
    return () => {
      if (workerIdPhotoUrl) URL.revokeObjectURL(workerIdPhotoUrl);
    };
  }, [workerIdPhotoUrl]);

  async function loadPayroll() {
    if (!currentFarm) return;
    try {
      const res = (await api.payroll(
        currentFarm,
        weekStart,
      )) as PayrollSheetResponse;
      setPayrollSheet(res);
    } catch (e) {
      toast(String(e));
    }
  }

  function saveBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function downloadProtectedExport(
    load: () => Promise<Blob>,
    filename: string,
  ) {
    try {
      saveBlob(await load(), filename);
    } catch (error) {
      toast(String(error));
    }
  }

  async function openProtectedPrintable(load: () => Promise<Blob>) {
    // Open synchronously from the click so popup protection does not suppress
    // an authenticated printable export that resolves a moment later.
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      toast("Allow pop-ups to open the printable export.");
      return;
    }
    printWindow.opener = null;
    printWindow.document.title = "Preparing secure export…";
    printWindow.document.body.textContent = "Preparing secure export…";
    try {
      const url = URL.createObjectURL(await load());
      printWindow.location.replace(url);
      window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (error) {
      printWindow.close();
      toast(String(error));
    }
  }

  async function refreshSmsDelivery() {
    if (!currentFarm || smsRefreshing) return;
    setSmsRefreshing(true);
    try {
      const result = (await api.refreshSmsDelivery(currentFarm)) as {
        checked: number;
        updated: number;
        delivered: number;
        sent: number;
        failed: number;
        queued: number;
        unavailable?: boolean;
        message?: string;
      };
      const latest = (await api.smsLog(currentFarm)) as { messages: unknown[] };
      setSmsLog(latest.messages ?? []);
      if (result.unavailable) {
        toast(result.message ?? "Mobile Sasa delivery lookup is not configured.");
      } else {
        toast(
          `Delivery checked: ${result.checked}; delivered ${result.delivered}, sent ${result.sent}, failed ${result.failed}, still pending ${result.queued}.`,
        );
      }
    } catch (e) {
      toast(String(e));
    } finally {
      setSmsRefreshing(false);
    }
  }

  async function sendOneOwnerSmsTest() {
    if (!currentFarm || smsTestSending || !smsTestReadiness?.ready) return;
    const approved = window.confirm(
      "Send exactly one neutral Tea Ledger delivery test to the preconfigured owner test recipient? No worker will be contacted, no payroll record will change, and the app will not retry it automatically.",
    );
    if (!approved) return;

    setSmsTestSending(true);
    try {
      const result = (await api.sendSmsTest(currentFarm)) as {
        sent: boolean;
        skipped: boolean;
        failed: boolean;
        reason?: string;
      };
      const [latest, readiness] = await Promise.all([
        api.smsLog(currentFarm) as Promise<{ messages: unknown[] }>,
        api.smsTestReadiness(currentFarm) as Promise<{ ready: boolean; reason: string | null }>,
      ]);
      setSmsLog(latest.messages ?? []);
      setSmsTestReadiness(readiness);
      if (result.sent) {
        toast("One owner delivery test was accepted by the provider. Use Refresh delivery status for the handset outcome.");
      } else if (result.failed) {
        toast("The one owner delivery test failed. It will not be retried automatically.");
      } else {
        toast(result.reason ?? "The owner delivery test was not sent.");
      }
    } catch (error) {
      toast(String(error));
    } finally {
      setSmsTestSending(false);
    }
  }

  async function openWorkerProfile(workerId: string) {
    if (!currentFarm || workerProfileLoading) return;
    setWorkerProfileLoading(true);
    setSelectedWorkerProfile(null);
    setWorkerIdPhotoUrl(null);
    try {
      const result = (await api.adminWorkerProfile(currentFarm, workerId)) as {
        worker: WorkerProfile;
      };
      setSelectedWorkerProfile(result.worker);
      if (result.worker.id_photo) {
        const blob = await api.adminWorkerIdPhoto(currentFarm, workerId);
        setWorkerIdPhotoUrl(URL.createObjectURL(blob));
      }
    } catch (error) {
      toast(String(error));
    } finally {
      setWorkerProfileLoading(false);
    }
  }

  function closeWorkerProfile() {
    setSelectedWorkerProfile(null);
    setWorkerIdPhotoUrl(null);
  }

  async function doCsvPreview() {
    try {
      const res = await api.csvPreview(currentFarm, csvText);
      setCsvPreview(res);
    } catch (e) {
      toast(String(e));
    }
  }
  async function doCsvCommit() {
    try {
      const res = (await api.csvCommit(currentFarm, csvText)) as {
        imported: number;
      };
      toast(`Imported ${res.imported} rows`);
      setCsvPreview(null);
    } catch (e) {
      toast(String(e));
    }
  }

  function logout(message = "Logged out") {
    clearAdminSession();
    // Do not leave a farm selection, private profile, Blob URL, or previously
    // loaded owner data visible after a manual or automatic session end.
    setCurrentFarm("");
    setFarms([]);
    setWorkers([]);
    setSelectedWorkerProfile(null);
    setWorkerIdPhotoUrl(null);
    setPayrollWeeks([]);
    setPayrollSheet(null);
    setCurrentWeekSheet(null);
    setLatestLockedSheet(null);
    setConflicts([]);
    setCorrections([]);
    setSmsLog([]);
    setMonthly([]);
    setHardest([]);
    setAudit([]);
    setRates([]);
    setCsvPreview(null);
    setIsPlatformAdmin(false);
    setActivationStatus(null);
    setMasterEmail("");
    setMasterPassword("");
    setPassword("");
    setActivationEmail("");
    setActivationPassword("");
    setActivationPasswordRepeat("");
    setShowFarmOwnerLogin(false);
    setTab("login");
    toast(message);
  }

  if (tab === "login") {
    return (
      <div className="admin-login">
        <div className="admin-login-kicker">Tea estate operations</div>
        <h2 style={{ margin: "10px 0 0" }}>
          {showFarmOwnerLogin ? "Farm Owner sign in" : "Master Admin"}
        </h2>
        {showFarmOwnerLogin ? (
          <>
            <p className="admin-login-copy">
              Existing farm-specific Owner accounts remain available for their own
              farm. New farms are created only from the central Master Console.
            </p>
            <form
              className="admin-login-form"
              onSubmit={(event) => {
                event.preventDefault();
                void doLogin();
              }}
            >
              <input
                aria-label="Farm Owner username"
                autoCapitalize="none"
                autoComplete="username"
                placeholder="Farm Owner username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
              <input
                aria-label="Farm Owner password"
                autoComplete="current-password"
                placeholder="Password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button className="primary" type="submit">
                Enter farm console
              </button>
            </form>
            {msg && (
              <div className="admin-login-message" role="status">
                {msg}
              </div>
            )}
            <button
              className="admin-login-link-button"
              type="button"
              onClick={() => {
                setMsg("");
                setPassword("");
                setShowFarmOwnerLogin(false);
              }}
            >
              Back to Master Admin sign in
            </button>
          </>
        ) : (
          <>
            <p className="admin-login-copy">
              One secure sign-in for all farms, Supervisors, and field-device access.
              Use the email address and Master password created during one-time activation.
            </p>
            <form
              className="admin-login-form"
              onSubmit={(event) => {
                event.preventDefault();
                void doMasterLogin();
              }}
            >
              <input
                aria-label="Master Admin email address"
                type="email"
                autoCapitalize="none"
                autoComplete="email"
                placeholder="Email address"
                value={masterEmail}
                disabled={masterLoginBusy}
                onChange={(event) => setMasterEmail(event.target.value)}
              />
              <input
                aria-label="Master Admin password"
                autoComplete="current-password"
                placeholder="Master password"
                type="password"
                value={masterPassword}
                disabled={masterLoginBusy}
                onChange={(event) => setMasterPassword(event.target.value)}
              />
              <button className="primary" type="submit" disabled={masterLoginBusy}>
                {masterLoginBusy ? "Signing in…" : "Enter Master Console"}
              </button>
            </form>
            {msg && (
              <div className="admin-login-message" role="status">
                {msg}
              </div>
            )}
            <div className="admin-login-divider"><span>or</span></div>
            <button
              className="admin-login-register-button"
              type="button"
              onClick={() => {
                setMsg("");
                setMasterPassword("");
                setShowFarmOwnerLogin(true);
              }}
            >
              Existing farm Owner sign in
            </button>
            <p className="admin-login-footer">
              First-time Master setup is protected inside the current trusted Owner/Admin
              console. It does not send email or SMS and never asks you to share credentials in chat.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div className="admin-brand">
          <div className="admin-crest" aria-hidden="true">
            <span>TL</span>
          </div>
          <div>
            <h1>Tea Ledger</h1>
            <small>{isPlatformAdmin ? "Master Admin · all farms" : "Farm Owner console"}</small>
          </div>
          <select
            value={currentFarm}
            onChange={(e) => {
              setCurrentFarm(e.target.value);
              setFarmId(e.target.value);
            }}
          >
            {farms.map((f) => (
              <option key={f.farm_id} value={f.farm_id}>
                {f.name} ({f.farm_id.slice(0, 8)})
              </option>
            ))}
            {farms.length === 0 && <option>No farms</option>}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, opacity: 0.72, color: "white" }}>
            {currentFarm ? `Farm ${currentFarm.slice(0, 8)}` : isPlatformAdmin ? "All farms" : ""}
          </span>
          {isPlatformAdmin && (
            <button className="new-farm-button" onClick={() => setTab("farms")}>
              + New farm
            </button>
          )}
          <button className="logout-button" onClick={logout}>
            Logout
          </button>
        </div>
      </header>
      <nav className="admin-nav">
        {(isPlatformAdmin
          ? [
              "farms",
              "dashboard",
              "workers",
              "payroll",
              "conflicts",
              "sms",
              "reports",
              "import",
              "settings",
              "audit",
            ]
          : [
              "dashboard",
              "workers",
              "payroll",
              "conflicts",
              "sms",
              "reports",
              "import",
              "settings",
              "audit",
            ]
        ).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t as Tab)}
            className={tab === t ? "active" : ""}
          >
            {t === "farms" ? "Farms" : t}
          </button>
        ))}
      </nav>
      {msg && <div className="admin-toast">{msg}</div>}
      <main className="admin-content">
        {isPlatformAdmin && tab === "farms" && (
          <MasterFarmPanel
            farms={farms}
            onCreated={(farm) => {
              setFarms((existing) =>
                [...existing.filter((item) => item.farm_id !== farm.farm_id), farm].sort((a, b) =>
                  a.name.localeCompare(b.name),
                ),
              );
              setCurrentFarm(farm.farm_id);
              setFarmId(farm.farm_id);
              void loadFarms();
            }}
            onOpenFarm={(nextFarm) => {
              setCurrentFarm(nextFarm);
              setFarmId(nextFarm);
              setTab("dashboard");
            }}
          />
        )}

        {!isPlatformAdmin && activationStatus?.can_activate && tab === "dashboard" && (
          <section className="card master-activation-card">
            <div className="admin-dashboard-kicker" style={{ color: "#b86f36" }}>
              One-time secure setup
            </div>
            <h3>Activate your Master Console</h3>
            <p className="muted" style={{ maxWidth: 760 }}>
              This trusted existing Admin account can activate one central Master Admin.
              Choose the email address and Master password you will use to manage all farms.
              Do not enter either anywhere outside this protected screen.
            </p>
            <form
              className="master-activation-form"
              onSubmit={(event) => {
                event.preventDefault();
                void activateMasterAdmin();
              }}
            >
              <label>
                Master Admin email address
                <input
                  aria-label="Master Admin setup email address"
                  type="email"
                  autoCapitalize="none"
                  autoComplete="email"
                  placeholder="Email address"
                  value={activationEmail}
                  disabled={activationBusy}
                  onChange={(event) => setActivationEmail(event.target.value)}
                />
              </label>
              <label>
                Choose Master password
                <input
                  aria-label="Choose Master password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 12 characters"
                  minLength={12}
                  maxLength={128}
                  value={activationPassword}
                  disabled={activationBusy}
                  onChange={(event) => setActivationPassword(event.target.value)}
                />
              </label>
              <label>
                Repeat Master password
                <input
                  aria-label="Repeat Master password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Repeat Master password"
                  minLength={12}
                  maxLength={128}
                  value={activationPasswordRepeat}
                  disabled={activationBusy}
                  onChange={(event) => setActivationPasswordRepeat(event.target.value)}
                />
              </label>
              <button className="primary" type="submit" disabled={activationBusy}>
                {activationBusy ? "Activating Master Console…" : "Activate Master Console"}
              </button>
            </form>
            {activationMessage && (
              <p className="master-activation-message" role="status">
                {activationMessage}
              </p>
            )}
          </section>
        )}

        {tab === "dashboard" && (
          <>
            <section className="admin-dashboard-hero">
              <div className="admin-dashboard-kicker">Estate overview</div>
              <h3>
                Welcome to{" "}
                {farms.find((f) => f.farm_id === currentFarm)?.name ??
                  "your farm"}
              </h3>
              <p>
                Today’s operational picture, kept clear and grounded in the
                synced farm record.
              </p>
              <div className="admin-metrics">
                <div className="admin-metric-card">
                  <div className="metric-value">{workers.length}</div>
                  <div className="metric-label">Workers</div>
                </div>
                <div className="admin-metric-card">
                  <div className="metric-value">{payrollWeeks.length}</div>
                  <div className="metric-label">Pay weeks</div>
                </div>
                <div
                  className={`admin-metric-card ${conflicts.length ? "is-alert" : ""}`}
                >
                  <div className="metric-value">{conflicts.length}</div>
                  <div className="metric-label">Unresolved conflicts</div>
                </div>
                <div
                  className={`admin-metric-card ${corrections.length ? "is-warm" : ""}`}
                >
                  <div className="metric-value">{corrections.length}</div>
                  <div className="metric-label">Correction requests</div>
                </div>
              </div>
            </section>
            <section className="card">
              <div className="dashboard-week-toolbar">
                <div>
                  <div
                    className="admin-dashboard-kicker"
                    style={{ color: "#b86f36" }}
                  >
                    Payroll lens
                  </div>
                  <h4>Weekly pay overview</h4>
                  <p className="muted" style={{ margin: "4px 0 0" }}>
                    Calculated on the server from synced entries and farm rates
                    — no dashboard-side payroll math.
                  </p>
                </div>
                <button className="secondary" onClick={loadDashboard}>
                  Refresh
                </button>
              </div>
              <div className="dashboard-week-section">
                <WeekPayTable title="This week" data={currentWeekSheet} live />
                {latestLockedSheet ? (
                  <WeekPayTable
                    title="Latest locked week"
                    data={latestLockedSheet}
                  />
                ) : (
                  <section className="week-pay-card">
                    <h3 style={{ marginTop: 0 }}>Latest locked week</h3>
                    <p className="muted">
                      No weekly payroll has been locked yet. Saturday FINAL
                      locks the selected Monday–Saturday week after server
                      checks pass.
                    </p>
                  </section>
                )}
              </div>
              {dashboardLoadedAt && (
                <p className="muted" style={{ marginBottom: 0 }}>
                  Overview refreshed at {dashboardLoadedAt}.
                </p>
              )}
              <h4>Pay weeks</h4>
              <table>
                <thead>
                  <tr>
                    <th>Week</th>
                    <th>Status</th>
                    <th>Locked at</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    payrollWeeks as Array<{
                      week_start: string;
                      week_end: string;
                      status: string;
                      locked_at: string | null;
                    }>
                  ).map((w) => (
                    <tr key={w.week_start}>
                      <td>
                        {w.week_start} → {w.week_end}
                      </td>
                      <td>
                        <span
                          className={`badge ${w.status === "locked" ? "locked" : "open"}`}
                        >
                          {w.status}
                        </span>
                      </td>
                      <td>
                        {w.locked_at
                          ? new Date(w.locked_at).toLocaleString()
                          : "-"}
                      </td>
                    </tr>
                  ))}
                  {payrollWeeks.length === 0 && (
                    <tr>
                      <td
                        colSpan={3}
                        style={{ textAlign: "center", color: "#6B6B5E" }}
                      >
                        No weeks yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <p style={{ fontSize: 12, color: "#4A4A42" }}>
                Data is append-only and server-authoritative. Kg does not
                reflect leaf quality — ranking only (see Reports).
              </p>
            </section>
          </>
        )}

        {tab === "workers" && (
          <div className="card worker-profiles-card">
            <div className="worker-profiles-heading">
              <div>
                <div className="admin-dashboard-kicker" style={{ color: "#b86f36" }}>
                  Private staff records
                </div>
                <h3>Worker profiles</h3>
                <p className="muted" style={{ margin: 0, maxWidth: 720 }}>
                  Name and phone remain visible in the field register. National
                  ID details and optional ID images are private to this signed-in
                  Admin account and are never included in SMS, exports, or PWA sync.
                </p>
              </div>
              <button className="secondary" onClick={loadDashboard}>
                Refresh
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th>Phone</th>
                    <th>Status</th>
                    <th>ID record</th>
                    <th>Photo</th>
                    <th aria-label="Open profile"></th>
                  </tr>
                </thead>
                <tbody>
                  {workers.map((worker) => (
                    <tr key={worker.worker_id}>
                      <td>
                        <strong>{worker.full_name}</strong>
                        <div className="worker-profile-subline">
                          Added {new Date(worker.created_at).toLocaleDateString()}
                        </div>
                      </td>
                      <td>{worker.phone_e164 ?? "—"}</td>
                      <td>
                        <span
                          className={`badge ${worker.status === "active" ? "locked" : "open"}`}
                        >
                          {worker.status}
                        </span>
                      </td>
                      <td>
                        <span className={worker.has_identity ? "identity-on-file" : "identity-missing"}>
                          {worker.has_identity ? "On file" : "Needs update"}
                        </span>
                      </td>
                      <td>{worker.has_id_photo ? "On file" : "Optional — none"}</td>
                      <td>
                        <button
                          className="secondary worker-profile-open"
                          onClick={() => openWorkerProfile(worker.worker_id)}
                          disabled={workerProfileLoading}
                        >
                          View profile
                        </button>
                      </td>
                    </tr>
                  ))}
                  {workers.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ textAlign: "center", color: "#6B6B5E" }}>
                        No workers yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="worker-profiles-footnote">
              Existing workers can be completed gradually. Identity details are
              not a payroll block, and access is recorded in the audit log.
            </p>

            {(workerProfileLoading || selectedWorkerProfile) && (
              <section className="worker-profile-detail" aria-live="polite">
                <div className="worker-profile-detail-heading">
                  <div>
                    <div className="admin-dashboard-kicker" style={{ color: "#b86f36" }}>
                      Admin-only identity profile
                    </div>
                    <h4>
                      {workerProfileLoading
                        ? "Opening private profile…"
                        : selectedWorkerProfile?.full_name}
                    </h4>
                  </div>
                  {!workerProfileLoading && (
                    <button className="secondary" onClick={closeWorkerProfile}>
                      Close profile
                    </button>
                  )}
                </div>
                {!workerProfileLoading && selectedWorkerProfile && (
                  <div className="worker-profile-detail-grid">
                    <dl>
                      <div>
                        <dt>Phone number</dt>
                        <dd>{selectedWorkerProfile.phone_e164 ?? "Not recorded"}</dd>
                      </div>
                      <div>
                        <dt>Employment status</dt>
                        <dd>{selectedWorkerProfile.status}</dd>
                      </div>
                      <div>
                        <dt>National ID number</dt>
                        <dd className="identity-value">
                          {selectedWorkerProfile.national_id_number ?? "Not recorded yet"}
                        </dd>
                      </div>
                      <div>
                        <dt>Identity consent</dt>
                        <dd>
                          {selectedWorkerProfile.identity_consent_at
                            ? `Recorded ${new Date(selectedWorkerProfile.identity_consent_at).toLocaleString()} by ${selectedWorkerProfile.identity_consent_author ?? "supervisor"}`
                            : "Not recorded yet"}
                        </dd>
                      </div>
                    </dl>
                    <div className="worker-id-photo-panel">
                      <div className="worker-id-photo-label">ID card image</div>
                      {workerIdPhotoUrl ? (
                        <img
                          src={workerIdPhotoUrl}
                          alt={`Private ID document for ${selectedWorkerProfile.full_name}`}
                        />
                      ) : selectedWorkerProfile.id_photo ? (
                        <p className="muted">Loading private image…</p>
                      ) : (
                        <p className="muted">No ID image was attached. It is optional.</p>
                      )}
                      {selectedWorkerProfile.id_photo && (
                        <small>
                          {selectedWorkerProfile.id_photo.content_type} · {Math.ceil(selectedWorkerProfile.id_photo.byte_size / 1024)} KB · recorded {new Date(selectedWorkerProfile.id_photo.captured_at).toLocaleDateString()}
                        </small>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>
        )}

        {tab === "payroll" && (
          <div className="card">
            <h3>Payroll Sheets — with flags</h3>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <label>
                Week start (Mon):{" "}
                <input
                  type="date"
                  value={weekStart}
                  onChange={(e) => setWeekStart(e.target.value)}
                />
              </label>
              <button className="primary" onClick={loadPayroll}>
                Load Sheet
              </button>
              {payrollSheet && (
                <button
                  className="secondary"
                  onClick={() =>
                    void downloadProtectedExport(
                      () => api.payrollExport(currentFarm, weekStart, "csv"),
                      `payroll-${weekStart}.csv`,
                    )
                  }
                >
                  Download payroll CSV
                </button>
              )}
              {payrollSheet && (
                <button
                  className="secondary"
                  onClick={() =>
                    void openProtectedPrintable(() =>
                      api.payrollExport(currentFarm, weekStart, "html"),
                    )
                  }
                >
                  Print payroll / Save PDF
                </button>
              )}
              {payrollSheet && (
                <button
                  className="secondary"
                  onClick={() =>
                    void downloadProtectedExport(
                      () => api.kgRegisterExport(currentFarm, weekStart, "csv"),
                      `kg-register-${weekStart}.csv`,
                    )
                  }
                >
                  Download kg register CSV
                </button>
              )}
              {payrollSheet && (
                <button
                  className="secondary"
                  onClick={() =>
                    void openProtectedPrintable(() =>
                      api.kgRegisterExport(currentFarm, weekStart, "html"),
                    )
                  }
                >
                  Print weekly kg register / Save PDF
                </button>
              )}
            </div>
            {payrollSheet ? (
              <div style={{ marginTop: 12 }}>
                <div>
                  <span
                    className={`badge ${payrollSheet.sheet.status === "locked" ? "locked" : "open"}`}
                  >
                    {payrollSheet.sheet.status}
                  </span>{" "}
                  {payrollSheet.sheet.weekStart} → {payrollSheet.sheet.weekEnd}
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Worker</th>
                      <th>Phone</th>
                      <th>Days</th>
                      <th>Kg</th>
                      <th>Amount KES</th>
                      <th>Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payrollSheet.sheet.lines.map(
                      (l: {
                        name: string;
                        maskedPhone: string;
                        daysWorked: number;
                        totalKg: number;
                        amountKes: number;
                        flags: string[];
                      }) => (
                        <tr key={l.name}>
                          <td>{l.name}</td>
                          <td>{l.maskedPhone}</td>
                          <td>{l.daysWorked}</td>
                          <td>{l.totalKg.toFixed(1)}</td>
                          <td>
                            <strong>{l.amountKes}</strong>
                          </td>
                          <td>
                            {l.flags.map((f: string) => (
                              <span
                                key={f}
                                className="flag"
                                style={{ marginRight: 4 }}
                              >
                                {f}
                              </span>
                            ))}
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3}>
                        <strong>Totals</strong>
                      </td>
                      <td>
                        <strong>
                          {payrollSheet.sheet.totals.totalKg.toFixed(1)}
                        </strong>
                      </td>
                      <td>
                        <strong>
                          KES {payrollSheet.sheet.totals.totalAmountKes}
                        </strong>
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <p style={{ color: "#6B6B5E" }}>
                Pick a Monday and load. Grand total is sum of rounded worker
                amounts. Anomaly flags computed from trailing 4 weeks.
              </p>
            )}
            <h4 style={{ marginTop: 16 }}>
              Next-week Adjustment (post-lock correction)
            </h4>
            <p style={{ fontSize: 12, color: "#4A4A42" }}>
              Locked week corrections never edit history; Admin creates
              adjustment applied to next week. Owner notified by SMS.
            </p>
            <AdjustmentForm
              farmId={currentFarm}
              onDone={() => toast("Adjustment created → next week")}
            />
          </div>
        )}

        {tab === "conflicts" && (
          <div className="card">
            <h3>Unresolved Same-Worker/Same-Day Conflicts</h3>
            <p style={{ fontSize: 12, color: "#4A4A42" }}>
              Never silent last-write-wins (Decision 20). Resolution is a new
              event. Phase 1 normally one device.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Event</th>
                  <th>Conflict</th>
                </tr>
              </thead>
              <tbody>
                {(
                  conflicts as Array<{
                    business_date: string;
                    event_type: string;
                    conflict_flag: boolean;
                    payload: { worker_id: string };
                  }>
                ).map((c, i) => (
                  <tr key={i}>
                    <td>{c.business_date.slice(0, 10)}</td>
                    <td>{c.event_type}</td>
                    <td>
                      {c.conflict_flag ? "⚠️ unresolved" : ""}{" "}
                      {c.payload?.worker_id?.slice(0, 8)}
                    </td>
                  </tr>
                ))}
                {conflicts.length === 0 && (
                  <tr>
                    <td
                      colSpan={3}
                      style={{ textAlign: "center", color: "#6B6B5E" }}
                    >
                      No conflicts
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <h4>Correction Requests (late events for locked week)</h4>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Payload</th>
                  <th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {(
                  corrections as Array<{
                    business_date: string;
                    payload: unknown;
                    correction_flag: boolean;
                  }>
                ).map((c, i) => (
                  <tr key={i}>
                    <td>{c.business_date.slice(0, 10)}</td>
                    <td
                      style={{
                        fontSize: 11,
                        maxWidth: 300,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {JSON.stringify(c.payload).slice(0, 120)}
                    </td>
                    <td>{c.correction_flag ? "correction" : ""}</td>
                  </tr>
                ))}
                {corrections.length === 0 && (
                  <tr>
                    <td
                      colSpan={3}
                      style={{ textAlign: "center", color: "#6B6B5E" }}
                    >
                      No corrections
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "sms" && (
          <div className="card">
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div>
                <h3 style={{ marginBottom: 4 }}>SMS Log — truthful delivery status</h3>
                <p style={{ margin: 0, fontSize: 12, color: "#4A4A42", maxWidth: 690 }}>
                  <strong>Queued</strong> means Mobile Sasa accepted the message
                  request. It is not handset delivery confirmation. Refresh asks
                  Mobile Sasa for delivery reports only — it never sends, retries,
                  or consumes an SMS unit.
                </p>
              </div>
              <button
                className="primary"
                onClick={refreshSmsDelivery}
                disabled={smsRefreshing || !currentFarm}
                title="Read current delivery reports from Mobile Sasa; no SMS will be sent"
              >
                {smsRefreshing ? "Checking delivery…" : "Refresh delivery status"}
              </button>
            </div>
            <section
              style={{
                margin: "12px 0",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #D5E1D2",
                background: "#F8FBF6",
              }}
            >
              <strong style={{ display: "block", marginBottom: 4 }}>One-recipient delivery test</strong>
              <p style={{ margin: "0 0 8px", fontSize: 12, color: "#4A4A42" }}>
                This can send one neutral test only to the preconfigured owner test recipient. It never contacts workers, changes payroll, or retries automatically.
              </p>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: smsTestReadiness?.ready ? "#1F6A3C" : "#7B5B1A" }}>
                  {smsTestReadiness
                    ? smsTestReadiness.ready
                      ? "Ready for one owner-approved test."
                      : smsTestReadiness.reason ?? "Not ready for a delivery test."
                    : "Checking test readiness…"}
                </span>
                <button
                  className="primary"
                  onClick={sendOneOwnerSmsTest}
                  disabled={!smsTestReadiness?.ready || smsTestSending || !currentFarm}
                  title="Requires an explicit confirmation and sends only one owner test SMS"
                >
                  {smsTestSending ? "Sending one test…" : "Send one owner test SMS"}
                </button>
              </div>
            </section>
            <div
              style={{
                margin: "12px 0",
                padding: "9px 11px",
                borderRadius: 8,
                background: "#F4F7F1",
                border: "1px solid #D5E1D2",
                color: "#355344",
                fontSize: 12,
              }}
            >
              <strong>Status key:</strong> Delivered = Mobile Sasa has a handset
              confirmation; Sent = carrier accepted, still not handset-confirmed;
              Failed = Mobile Sasa reported a terminal failure; Queued = accepted
              and still waiting for a provider report.
            </div>
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>To</th>
                  <th>Body</th>
                  <th>Segs</th>
                  <th>Truthful status</th>
                </tr>
              </thead>
              <tbody>
                {(
                  smsLog as Array<{
                    type: string;
                    to_phone: string;
                    body: string;
                    segments: number;
                    status: "queued" | "sent" | "delivered" | "failed" | string;
                  }>
                ).map((m, i) => {
                  const display =
                    m.status === "delivered"
                      ? "Delivered · handset confirmed"
                      : m.status === "sent"
                        ? "Sent · carrier accepted"
                        : m.status === "failed"
                          ? "Failed · provider reported"
                          : "Queued · accepted, awaiting report";
                  const color =
                    m.status === "delivered"
                      ? "#1F6A3C"
                      : m.status === "failed"
                        ? "#A63D28"
                        : m.status === "sent"
                          ? "#7B5B1A"
                          : "#5F625B";
                  return (
                    <tr key={i}>
                      <td>{m.type}</td>
                      <td>{m.to_phone}</td>
                      <td
                        style={{
                          maxWidth: 300,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontSize: 12,
                        }}
                      >
                        {m.body.slice(0, 80)}
                      </td>
                      <td>{m.segments}</td>
                      <td>
                        <span
                          style={{
                            color,
                            fontWeight: 700,
                            fontSize: 12,
                          }}
                        >
                          {display}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {smsLog.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      style={{ textAlign: "center", color: "#6B6B5E" }}
                    >
                      No SMS
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <p style={{ fontSize: 12, color: "#4A4A42", marginBottom: 0 }}>
              Delivery reports are reconciled read-only against the provider.
              Real-time callback support is securely disabled until its separate
              Mobile Sasa webhook secret is configured; it will never guess a
              delivery outcome.
            </p>
          </div>
        )}

        {tab === "reports" && (
          <div className="card">
            <h3>Reports — quarterly & monthly</h3>
            {(() => {
              const rows = monthly as Array<{
                month: string;
                total_kg: number;
                payroll_kes: number;
                active_workers: number;
              }>;
              const bestMonth = rows.length
                ? rows.reduce((a, b) => (b.total_kg > a.total_kg ? b : a))
                : null;
              const last3 = rows.slice(-3);
              const kg3 = last3.reduce(
                (s, m) => s + (Number(m.total_kg) || 0),
                0,
              );
              const pay3 = last3.reduce(
                (s, m) => s + (Number(m.payroll_kes) || 0),
                0,
              );
              const top = (
                hardest as Array<{
                  name: string;
                  total_kg: number;
                  avg_kg_per_day: number;
                  attendance_rate: number | null;
                  days_attended: number;
                  attendance_denom: number;
                }>
              )[0];
              return (
                <>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
                      gap: 10,
                      margin: "10px 0 16px",
                    }}
                  >
                    <StatCard
                      label="Best month"
                      value={bestMonth ? String(bestMonth.month) : "—"}
                      sub={
                        bestMonth
                          ? `${Number(bestMonth.total_kg).toLocaleString()} kg picked`
                          : "no data yet"
                      }
                    />
                    <StatCard
                      label="Hardest worker"
                      value={top ? top.name : "—"}
                      sub={
                        top
                          ? `${Number(top.total_kg).toLocaleString()} kg · ${Number(top.avg_kg_per_day).toFixed(1)} kg/day`
                          : `no data for ${quarter}`
                      }
                    />
                    <StatCard
                      label="Last 3 months"
                      value={`${kg3.toLocaleString()} kg`}
                      sub={`KES ${pay3.toLocaleString()} payroll`}
                    />
                    <StatCard
                      label="Months recorded"
                      value={String(rows.length)}
                      sub={`${rows.reduce((s, m) => s + (Number(m.active_workers) || 0), 0) ? "worker-months of activity" : "and counting"}`}
                    />
                  </div>
                  <h4>Total kg by month</h4>
                  <BarChart
                    data={rows.map((m) => ({
                      label: String(m.month),
                      value: Number(m.total_kg) || 0,
                    }))}
                    color="#2D6A3E"
                  />
                  <h4>Payroll by month (KES)</h4>
                  <BarChart
                    data={rows.map((m) => ({
                      label: String(m.month),
                      value: Number(m.payroll_kes) || 0,
                    }))}
                    color="#E3A72F"
                  />
                  <h4 style={{ marginTop: 18 }}>Monthly detail</h4>
                  <table>
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th>Total kg</th>
                        <th>Payroll KES</th>
                        <th>Workers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((m) => (
                        <tr key={m.month}>
                          <td>{m.month}</td>
                          <td>{Number(m.total_kg).toLocaleString()}</td>
                          <td>{Number(m.payroll_kes).toLocaleString()}</td>
                          <td>{m.active_workers}</td>
                        </tr>
                      ))}
                      {rows.length === 0 && (
                        <tr>
                          <td
                            colSpan={4}
                            style={{ textAlign: "center", color: "#6B6B5E" }}
                          >
                            No data yet
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  <h4 style={{ marginTop: 18 }}>
                    Hardest-working ranking —{" "}
                    <select
                      value={quarter}
                      onChange={(e) => setQuarter(e.target.value)}
                      style={{
                        fontSize: 14,
                        padding: "4px 8px",
                        borderRadius: 8,
                        border: "1px solid #D9D2BC",
                        background: "#FFFDF6",
                        color: "#23231F",
                      }}
                    >
                      {lastQuarters(8).map((q) => (
                        <option key={q} value={q}>
                          {q}
                        </option>
                      ))}
                    </select>
                  </h4>
                  <p style={{ fontSize: 12, color: "#4A4A42" }}>
                    Three measures side by side: total kg, avg kg per attended
                    plucking day, attendance rate (plucking days during active
                    employment). Kg does not reflect leaf quality — ranking
                    only.
                  </p>
                  <table>
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Worker</th>
                        <th>Total kg</th>
                        <th>Avg kg/day</th>
                        <th>Attendance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        hardest as Array<{
                          name: string;
                          total_kg: number;
                          avg_kg_per_day: number;
                          attendance_rate: number | null;
                          days_attended: number;
                          attendance_denom: number;
                        }>
                      ).map((h, i) => (
                        <tr key={h.name}>
                          <td>#{i + 1}</td>
                          <td>{h.name}</td>
                          <td>{Number(h.total_kg).toLocaleString()}</td>
                          <td>{Number(h.avg_kg_per_day).toFixed(1)}</td>
                          <td>
                            {h.attendance_rate !== null
                              ? `${(h.attendance_rate * 100).toFixed(1)}% (${h.days_attended}/${h.attendance_denom})`
                              : "-"}
                          </td>
                        </tr>
                      ))}
                      {hardest.length === 0 && (
                        <tr>
                          <td
                            colSpan={5}
                            style={{ textAlign: "center", color: "#6B6B5E" }}
                          >
                            No data for quarter
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </>
              );
            })()}
          </div>
        )}

        {tab === "import" && (
          <div className="card">
            <h3>CSV Import — historical records</h3>
            <p style={{ fontSize: 12, color: "#4A4A42" }}>
              Canonical template:
              worker_id,full_name,phone_e164,business_date,kg_units,present,is_plucking_day.
              Preview before commit; duplicates rejected for explicit
              resolution.
            </p>
            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              rows={10}
              style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="secondary" onClick={doCsvPreview}>
                Preview
              </button>
              <button className="primary" onClick={doCsvCommit}>
                Commit
              </button>
              <button
                className="secondary"
                onClick={() =>
                  void downloadProtectedExport(
                    () => api.csvTemplate(currentFarm),
                    "tea-ledger-import-template.csv",
                  )
                }
              >
                Download template
              </button>
            </div>
            {csvPreview ? (
              <pre
                style={{
                  background: "#F5F1E3",
                  padding: 12,
                  borderRadius: 8,
                  fontSize: 12,
                  overflow: "auto",
                }}
              >
                {JSON.stringify(csvPreview, null, 2)}
              </pre>
            ) : null}
          </div>
        )}

        {tab === "settings" && (
          <div className="card">
            <h3>Farm Settings</h3>
            <p style={{ fontSize: 12, color: "#4A4A42" }}>
              Rate with effective dates, thresholds, SMS language,
              Owner/supervisor numbers, cutoff times per farm_id.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Effective From</th>
                  <th>Rate KES/kg</th>
                </tr>
              </thead>
              <tbody>
                {(
                  rates as Array<{
                    effective_from: string;
                    rate_cents_per_kg: number;
                  }>
                ).map((r) => (
                  <tr key={r.effective_from}>
                    <td>{r.effective_from}</td>
                    <td>{(r.rate_cents_per_kg / 100).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <RateForm farmId={currentFarm} onDone={loadDashboard} />
            <SupervisorAccessPanel
              farmId={currentFarm}
              onDone={loadDashboard}
              isPlatformAdmin={isPlatformAdmin}
            />
            <FieldDeviceLinkPanel farmId={currentFarm} />
            <IdentitySafetyPanel farmId={currentFarm} />
          </div>
        )}

        {tab === "audit" && (
          <div className="card">
            <h3>Audit Log — every change with author & time</h3>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {(
                  audit as Array<{
                    created_at: string;
                    actor: string;
                    action: string;
                    target: string | null;
                  }>
                ).map((a, i) => (
                  <tr key={i}>
                    <td style={{ fontSize: 11 }}>
                      {new Date(a.created_at).toLocaleString()}
                    </td>
                    <td>{a.actor}</td>
                    <td>{a.action}</td>
                    <td>{a.target ?? "-"}</td>
                  </tr>
                ))}
                {audit.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      style={{ textAlign: "center", color: "#6B6B5E" }}
                    >
                      No audit entries
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

function AdjustmentForm({
  farmId,
  onDone,
}: {
  farmId: string;
  onDone: () => void;
}) {
  const [workerId, setWorkerId] = useState("");
  const [correctionWeek, setCorrectionWeek] = useState("2026-11-23");
  const [kg, setKg] = useState("5");
  const [reason, setReason] = useState("late correction");
  const [msg, setMsg] = useState("");
  async function submit() {
    try {
      await api.createAdjustment(farmId, {
        worker_id: workerId,
        correction_week_start: correctionWeek,
        kg: Number(kg),
        reason,
      });
      setMsg("Created");
      onDone();
    } catch (e) {
      setMsg(String(e));
    }
  }
  return (
    <div
      style={{
        background: "#FFF9F0",
        border: "1px solid #FFE0B2",
        borderRadius: 8,
        padding: 12,
        marginTop: 8,
      }}
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          placeholder="worker_id"
          value={workerId}
          onChange={(e) => setWorkerId(e.target.value)}
          style={{ flex: "1 1 180px" }}
        />
        <input
          type="date"
          value={correctionWeek}
          onChange={(e) => setCorrectionWeek(e.target.value)}
        />
        <input
          placeholder="kg"
          value={kg}
          onChange={(e) => setKg(e.target.value)}
          style={{ width: 80 }}
        />
      </div>
      <input
        placeholder="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{ width: "100%", marginTop: 8 }}
      />
      <button className="primary" onClick={submit} style={{ marginTop: 8 }}>
        Create Adjustment (next week)
      </button>
      {msg && <span style={{ marginLeft: 8, fontSize: 12 }}>{msg}</span>}
    </div>
  );
}

function RateForm({ farmId, onDone }: { farmId: string; onDone: () => void }) {
  const [effectiveFrom, setEffectiveFrom] = useState("2026-12-01");
  const [rate, setRate] = useState("10");
  const [msg, setMsg] = useState("");
  async function submit() {
    try {
      await api.setRate(farmId, effectiveFrom, Math.round(Number(rate) * 100));
      setMsg("Saved");
      onDone();
    } catch (e) {
      setMsg(String(e));
    }
  }
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        marginTop: 10,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <input
        type="date"
        value={effectiveFrom}
        onChange={(e) => setEffectiveFrom(e.target.value)}
      />
      <input
        value={rate}
        onChange={(e) => setRate(e.target.value)}
        placeholder="KES/kg"
        style={{ width: 80 }}
      />
      <button className="primary" onClick={submit}>
        Set Rate
      </button>
      {msg && <span style={{ fontSize: 12 }}>{msg}</span>}
    </div>
  );
}
