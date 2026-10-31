import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { getDb, runMigrations } from "@tea-ledger/database";
import { syncRoutes } from "./routes/sync.js";
import { farmsRoutes } from "./routes/farms.js";
import { workersRoutes } from "./routes/workers.js";
import { healthRoutes } from "./routes/health.js";
import { smsRoutes } from "./routes/sms.js";
import { cronRoutes } from "./routes/cron.js";
import { payrollRoutes } from "./routes/payroll.js";
import { adminRoutes } from "./routes/admin.js";
import { supervisorRoutes } from "./routes/supervisor.js";
import { supervisorsRoutes } from "./routes/supervisors.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "../../public"); // dist will adjust, check both
import { existsSync } from "node:fs";
export async function buildApp() {
  // Identity-photo uploads are compressed client-side and capped lower than
  // this server boundary. Keep the limit explicit so an oversized request is
  // rejected before it can consume an unbounded serverless function.
  const app = Fastify({ logger: true, bodyLimit: 2_000_000 });
  await app.register(cors, { origin: true });
  // Serve PWA static from public if exists (built via vite)
  const candidates = [publicDir, join(process.cwd(), "apps/api/public"), join(process.cwd(), "public")];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) {
      await app.register(fastifyStatic, { root: dir, prefix: "/", wildcard: false, decorateReply: false });
      // SPA fallback: serve index.html for non-API routes; /admin/* serves admin app
      app.get("/*", (req, reply) => {
        const url = req.url as string;
        if (url.startsWith("/api") || url.startsWith("/health")) return reply.callNotFound();
        if (url.startsWith("/admin")) {
          // Let fastify-static serve /admin assets if file exists, else fallback to admin/index.html
          if (existsSync(join(dir, "admin", "index.html"))) return reply.sendFile("admin/index.html");
          return reply.callNotFound();
        }
        return reply.sendFile("index.html");
      });
      break;
    }
  }
  app.register(healthRoutes);
  app.register(farmsRoutes);
  app.register(workersRoutes);
  app.register(syncRoutes);
  app.register(smsRoutes);
  app.register(cronRoutes);
  app.register(payrollRoutes);
  app.register(adminRoutes);
  app.register(supervisorRoutes);
  app.register(supervisorsRoutes);
  app.setErrorHandler((err: unknown, _req: unknown, reply: { status: (c: number) => { send: (o: unknown) => void } }) => {
    (app.log as { error: (e: unknown) => void }).error(err);
    const msg = err instanceof Error ? err.message : String(err);
    reply.status(500).send({ error: "internal_error", message: msg });
  });
  return app;
}
async function start() {
  const db = await getDb();
  try { await runMigrations(db); } catch (e) { console.error("Migrations failed", e); }
  const app = await buildApp();
  const port = Number(process.env.API_PORT ?? 3000);
  const host = process.env.API_HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  console.log(`API listening on http://${host}:${port} — USE_PGLITE=${process.env.USE_PGLITE} DEMO=${!process.env.DATABASE_URL ? "ephemeral" : "persistent"}`);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
