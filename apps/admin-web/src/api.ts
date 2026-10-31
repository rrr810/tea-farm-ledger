export function token(): string | null { return localStorage.getItem("admin_token"); }
export function setToken(t: string) { localStorage.setItem("admin_token", t); }
export function clearToken() { localStorage.removeItem("admin_token"); }
export function farmId(): string { return localStorage.getItem("farm_id") ?? ""; }
export function setFarmId(id: string) { localStorage.setItem("farm_id", id); }

async function req(path: string, opts: RequestInit = {}) {
  const h: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers as Record<string, string> ?? {}) };
  const t = token();
  if (t) h["Authorization"] = `Bearer ${t}`;
  const res = await fetch(path, { ...opts, headers: h });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${txt}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/csv") || ct.includes("text/html")) return res.text();
  return res.json();
}

export const api = {
  login: (username: string, password: string) => req("/api/admin/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  me: () => req("/api/admin/me"),
  farms: () => req("/api/farms"),
  workers: (fid: string) => req(`/api/farms/${fid}/workers`),
  adminWorkers: (fid: string) => req(`/api/admin/farms/${fid}/workers`),
  adminWorkerProfile: (fid: string, workerId: string) => req(`/api/admin/farms/${fid}/workers/${workerId}`),
  adminWorkerIdPhoto: async (fid: string, workerId: string) => {
    const res = await fetch(`/api/admin/farms/${fid}/workers/${workerId}/id-photo`, {
      headers: { Authorization: `Bearer ${token() ?? ""}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status} ${text}`);
    }
    return res.blob();
  },
  payroll: (fid: string, weekStart: string) => req(`/api/farms/${fid}/payroll/${weekStart}`),
  payrollWeeks: (fid: string) => req(`/api/farms/${fid}/payroll`),
  payrollCsv: (fid: string, weekStart: string) => fetch(`/api/farms/${fid}/payroll/${weekStart}?format=csv`, { headers: { Authorization: `Bearer ${token() ?? ""}` } }).then(r => r.text()),
  refreshSmsDelivery: (fid: string) => req(`/api/farms/${fid}/sms/refresh-delivery`, { method: "POST", body: JSON.stringify({}) }),
  conflicts: (fid: string) => req(`/api/farms/${fid}/conflicts`),
  corrections: (fid: string) => req(`/api/farms/${fid}/correction-requests`),
  smsLog: (fid: string) => req(`/api/sms-log?farm_id=${fid}&limit=100`),
  rates: (fid: string) => req(`/api/farms/${fid}/rates`),
  setRate: (fid: string, effective_from: string, rate_cents_per_kg: number) => req(`/api/farms/${fid}/rates`, { method: "POST", body: JSON.stringify({ effective_from, rate_cents_per_kg }) }),
  adjustments: (fid: string) => req(`/api/farms/${fid}/adjustments`),
  createAdjustment: (fid: string, body: Record<string, unknown>) => req(`/api/farms/${fid}/adjustments`, { method: "POST", body: JSON.stringify(body) }),
  monthly: (fid: string) => req(`/api/farms/${fid}/reports/monthly`),
  activeIdle: (fid: string, month: string) => req(`/api/farms/${fid}/reports/active-idle?month=${month}`),
  hardest: (fid: string, quarter: string) => req(`/api/farms/${fid}/reports/hardest-working?quarter=${quarter}`),
  auditLog: (fid: string) => req(`/api/farms/${fid}/audit-log`),
  supervisors: (fid: string) => req(`/api/admin/farms/${fid}/supervisors`),
  createSupervisor: (fid: string, username: string, password: string) =>
    req(`/api/admin/farms/${fid}/supervisors`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  resetSupervisorPassword: (fid: string, userId: string, password: string) =>
    req(`/api/admin/farms/${fid}/supervisors/${userId}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  csvPreview: (fid: string, csv: string) => req(`/api/farms/${fid}/csv-import/preview`, { method: "POST", body: JSON.stringify({ csv }) }),
  csvCommit: (fid: string, csv: string) => req(`/api/farms/${fid}/csv-import/commit`, { method: "POST", body: JSON.stringify({ csv }) }),
};
