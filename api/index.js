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
    // Preview-only, import-only probes identify a packaging failure without
    // executing a route, querying the database, or exposing an exception.
    // Production retains the regular minimal startup path.
    if (process.env.VERCEL_ENV === "preview") {
      const probes = [
        ["dependency_fastify", () => import("fastify")],
        ["dependency_fastify_cors", () => import("@fastify/cors")],
        ["dependency_fastify_static", () => import("@fastify/static")],
        ["dependency_pg", () => import("pg")],
        ["dependency_pglite", () => import("@electric-sql/pglite")],
        [
          "runtime_config",
          () => import("../apps/api/dist/runtime-packages/config/dist/index.js"),
        ],
        [
          "runtime_core",
          () => import("../apps/api/dist/runtime-packages/core/dist/index.js"),
        ],
        ["runtime_database", () => loadDatabaseRuntime()],
        ["runtime_sms", () => import("../apps/api/dist/runtime-packages/sms/dist/index.js")],
        ["route_sync", () => import("../apps/api/dist/routes/sync.js")],
        ["route_farms", () => import("../apps/api/dist/routes/farms.js")],
        ["route_workers", () => import("../apps/api/dist/routes/workers.js")],
        ["route_health", () => import("../apps/api/dist/routes/health.js")],
        ["route_sms", () => import("../apps/api/dist/routes/sms.js")],
        ["route_cron", () => import("../apps/api/dist/routes/cron.js")],
        ["route_payroll", () => import("../apps/api/dist/routes/payroll.js")],
        ["route_admin", () => import("../apps/api/dist/routes/admin.js")],
        ["route_supervisor", () => import("../apps/api/dist/routes/supervisor.js")],
        ["route_supervisors", () => import("../apps/api/dist/routes/supervisors.js")],
      ];
      for (const [label, load] of probes) {
        stage = label;
        await load();
      }
    }

    stage = "database_module";
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
        const code =
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string" &&
          /^(ERR_|MODULE_NOT_FOUND$)/.test(error.code)
            ? error.code
            : "unclassified";
        res.setHeader("x-tea-bootstrap-error-code", code);
      }
      res.statusCode = 503;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end('{"error":"service_unavailable"}');
      return;
    }
  }
  app.server.emit("request", req, res);
}
