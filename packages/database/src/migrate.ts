import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "./db.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
export async function runMigrations(db?: Awaited<ReturnType<typeof getDb>>) {
  const client = db ?? (await getDb());
  const isPglite = (client as unknown as { type: string }).type === "pglite";
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const candidates = [
    join(__dirname, "../migrations"),
    join(__dirname, "../../migrations"),
    join(process.cwd(), "packages/database/migrations"),
  ];
  let files: string[] = [];
  let baseDir = "";
  for (const dir of candidates) {
    try { files = await readdir(dir); baseDir = dir; break; } catch {}
  }
  files = files.filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = await readFile(join(baseDir, f), "utf-8");
    await apply(client, f, sql);
  }
  if (isPglite) {
    console.log("⚠️  Using PGlite embedded DB — data is ephemeral (demo only). For persistence set DATABASE_URL and USE_PGLITE=false");
  }
}
async function apply(client: Awaited<ReturnType<typeof getDb>>, name: string, sql: string) {
  const existing = await client.query("SELECT name FROM _migrations WHERE name = $1", [name]);
  if ((existing.rows as unknown[]).length > 0) return;
  console.log(`Applying migration ${name}...`);
  if (!sql.trim()) return;
  const maybePglite = client as unknown as { type: string; raw?: { exec?: (s:string)=>Promise<void> } };
  if (maybePglite.raw && typeof maybePglite.raw.exec === "function") {
    await maybePglite.raw.exec(sql);
  } else if (maybePglite.type === "pglite") {
    const statements = sql.split(/;\s*\n/).map(s=>s.trim()).filter(Boolean);
    for (const stmt of statements) { if (stmt) await client.query(stmt); }
  } else {
    await client.query(sql);
  }
  await client.query("INSERT INTO _migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(async () => { console.log("Migrations complete"); await closeDb(); process.exit(0); })
    .catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
}
