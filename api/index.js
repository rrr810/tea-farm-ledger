import { buildApp } from "../apps/api/dist/index.js";
import { getDb, runMigrations } from "../packages/database/dist/index.js";
let app;
export default async function handler(req, res) {
  if (!app) {
    try { const db = await getDb(); await runMigrations(db); } catch {}
    app = await buildApp();
    await app.ready();
  }
  app.server.emit('request', req, res);
}
