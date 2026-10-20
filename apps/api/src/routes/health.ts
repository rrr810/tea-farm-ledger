import type { FastifyInstance } from "fastify";
import { getDb } from "@tea-ledger/database";
export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    return { ok: true, tz: "Africa/Nairobi", demo: process.env.USE_PGLITE === "true" };
  });
  app.get("/api/health", async () => {
    const db = await getDb();
    try {
      await db.query("SELECT 1");
      return { ok: true, db: "connected", type: (db as { type: string }).type, demo: process.env.USE_PGLITE === "true" ? "ephemeral — resets on restart" : "persistent" };
    } catch (e) {
      return { ok: false, db: "error", error: String(e) };
    }
  });
}
