export async function pushEvents(events: unknown[]) {
  const res = await fetch("/api/sync/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }) });
  if (!res.ok) throw new Error(`push failed ${res.status}`);
  return res.json();
}
export async function pullEvents(farmId: string, since: number | null) {
  const url = new URL("/api/sync/pull", window.location.origin);
  url.searchParams.set("farm_id", farmId);
  if (since !== null) url.searchParams.set("since", String(since));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pull failed ${res.status}`);
  return res.json();
}
