import { buildApp } from "../apps/api/dist/index.js";
let app;
let ready = false;
export default async function handler(req, res) {
  if (!ready) {
    try {
      // Lazy load DB to avoid build-time migration failure
      const { getDb, runMigrations } = await import("../packages/database/dist/index.js");
      try { const db = await getDb(); await runMigrations(db); } catch (e) { console.error("migrate", e); }
    } catch (e) { console.error(e); }
    app = await buildApp();
    await app.ready();
    ready = true;
  }
  app.server.emit('request', req, res);
}
