let app;
let initializing;

async function loadDatabaseRuntime() {
  try {
    return await import("../apps/api/dist/runtime-packages/database/dist/index.js");
  } catch {
    // Local direct-handler use has not run the Vercel build; keep that safe path usable.
    return import("../packages/database/dist/index.js");
  }
}

async function initializeApp() {
  let stage = "database_module";
  try {
    const { getDb, runMigrations } = await loadDatabaseRuntime();
    stage = "migrations";
    try {
      const db = await getDb();
      await runMigrations(db);
    } catch (error) {
      // Migration errors are deliberately logged but do not prevent the app
      // from serving its health endpoint or an operator from diagnosing them.
      console.error("migrate", error);
    }

    stage = "app_module";
    const { buildApp } = await import("../apps/api/dist/index.js");
    stage = "app_build";
    const built = await buildApp();
    stage = "app_ready";
    await built.ready();
    app = built;
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    Object.assign(wrapped, { bootstrapStage: stage });
    throw wrapped;
  }
}

async function ensureApp() {
  if (app) return;
  if (!initializing) {
    initializing = initializeApp().finally(() => {
      initializing = undefined;
    });
  }
  await initializing;
}

export default async function handler(req, res) {
  if (!app) {
    try {
      await ensureApp();
    } catch (error) {
      const stage =
        error && typeof error === "object" && "bootstrapStage" in error
          ? String(error.bootstrapStage)
          : "unknown";
      // Keep the exception in Vercel runtime logs. The browser gets no stack or
      // configuration data; Preview exposes only a fixed failure stage to aid
      // safe deployment diagnosis.
      console.error("API bootstrap failed", { stage, error });
      if (process.env.VERCEL_ENV === "preview") {
        res.setHeader("x-tea-bootstrap-stage", stage);
      }
      res.statusCode = 503;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end('{"error":"service_unavailable"}');
      return;
    }
  }
  app.server.emit("request", req, res);
}
