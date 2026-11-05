import { buildApp } from "../apps/api/dist/index.js";
let app;
let ready = false;
export default async function handler(req, res) {
  if (!ready) {
    try {
      // The Vercel build materializes workspace modules with relative imports so
      // Lambda startup never depends on an npm workspace symlink being traced.
      let database;
      try {
        database = await import("../apps/api/dist/runtime-packages/database/dist/index.js");
      } catch {
        // Local direct-handler use has not run the Vercel build; keep that safe path usable.
        database = await import("../packages/database/dist/index.js");
      }
      const { getDb, runMigrations } = database;
      try { const db = await getDb(); await runMigrations(db); } catch (e) { console.error("migrate", e); }
    } catch (e) { console.error(e); }
    app = await buildApp();
    await app.ready();
    ready = true;
  }
  app.server.emit('request', req, res);
}
