import Fastify from "fastify";
import cors from "@fastify/cors";
import { getDb, runMigrations } from "@tea-ledger/database";
import { syncRoutes } from "./routes/sync.js";
import { farmsRoutes } from "./routes/farms.js";
import { healthRoutes } from "./routes/health.js";
export async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  app.register(healthRoutes);
  app.register(farmsRoutes);
  app.register(syncRoutes);
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
