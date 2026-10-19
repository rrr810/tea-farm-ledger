import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
export type DbClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  end?: () => Promise<void>;
  type: "pg" | "pglite";
  raw?: unknown;
};
let pool: Pool | null = null;
let pglite: PGlite | null = null;
export async function getDb(): Promise<DbClient> {
  const usePglite = process.env.USE_PGLITE === "true" || !process.env.DATABASE_URL || process.env.DATABASE_URL.includes("pglite");
  if (usePglite) {
    if (!pglite) { pglite = new PGlite(); }
    return {
      type: "pglite",
      raw: pglite,
      query: async (text: string, params?: unknown[]) => {
        const res = await (pglite as unknown as { query: (t: string, p: unknown[]) => Promise<{ rows: unknown[]; affectedRows: number }> }).query(text, (params as unknown[]) ?? []);
        return { rows: res.rows, rowCount: (res as unknown as { affectedRows: number }).affectedRows ?? res.rows.length };
      },
    };
  } else {
    if (!pool) {
      const url = process.env.DATABASE_URL!;
      pool = new Pool({ connectionString: url, ssl: url.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined });
    }
    return {
      type: "pg",
      raw: pool,
      query: (text: string, params?: unknown[]) => pool!.query(text, params),
      end: async () => { if (pool) await pool.end(); },
    };
  }
}
export async function closeDb() {
  if (pool) { await pool.end(); pool = null; }
  if (pglite) { await pglite.close(); pglite = null; }
}
export async function createTestDb(): Promise<DbClient> {
  const testLite = new PGlite();
  return {
    type: "pglite",
    raw: testLite,
    query: async (text: string, params?: unknown[]) => {
      const res = await (testLite as unknown as { query: (t: string, p: unknown[]) => Promise<{ rows: unknown[]; affectedRows: number }> }).query(text, (params as unknown[]) ?? []);
      return { rows: res.rows, rowCount: (res as unknown as { affectedRows: number }).affectedRows ?? res.rows.length };
    },
    end: async () => { await testLite.close(); },
  };
}
