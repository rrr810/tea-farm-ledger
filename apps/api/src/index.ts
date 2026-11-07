import Fastify from "fastify";
import cors from "@fastify/cors";
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
import { fieldDeviceLinkRoutes } from "./routes/field-device-link.js";
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
  // The Supervisor PWA and Owner console are served from this exact origin.
  // Do not reflect arbitrary browser origins for authenticated farm APIs.
  await app.register(cors, { origin: false });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'",
    );
    return payload;
  });
  // Vercel's filesystem routing serves apps/api/public before this Lambda is
  // invoked. Avoid loading the CJS static plugin there: its job is redundant
  // in the serverless runtime and an upstream ESM dependency can otherwise
  // prevent the API from booting. Local API development keeps the same PWA and
  // admin fallback behavior through the plugin.
  if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
    const { default: fastifyStatic } = await import("@fastify/static");
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
  app.register(fieldDeviceLinkRoutes);
  app.setErrorHandler((err: unknown, _req: unknown, reply: { status: (c: number) => { send: (o: unknown) => void } }) => {
    // Keep diagnostic detail in Vercel logs, never in a browser/API response.
    (app.log as { error: (e: unknown) => void }).error(err);
    reply.status(500).send({ error: "internal_error" });
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
