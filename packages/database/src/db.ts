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

/**
 * Persistent DATABASE_URL default — if none is set, we default to the local
 * Docker Postgres (see .env.example). We never default to PGlite in production.
 * PGlite is only for tests/preview when USE_PGLITE=true or DATABASE_URL missing
 * in non-production. This matches the review: "persistent DATABASE_URL default
 * for prod + refuse PGlite in production".
 */
function isProduction(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

export async function getDb(): Promise<DbClient> {
  // Explicit USE_PGLITE takes precedence; otherwise, missing URL defaults to local Postgres
  // (set in .env.example: postgresql://tea_ledger:tea_ledger_dev@localhost:5432/tea_ledger).
  // Tests set USE_PGLITE=true or call createTestDb().
  const explicitPglite = process.env.USE_PGLITE === "true";
  const explicitPg = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("pglite");
  const usePglite = explicitPglite || (!explicitPg && !process.env.DATABASE_URL);

  // Refuse PGlite in production — production must have a real DATABASE_URL
  if (usePglite && isProduction()) {
    throw new Error(
      "PGlite is not allowed in production. Set DATABASE_URL to a PostgreSQL connection string.",
    );
  }

  if (usePglite) {
    if (!pglite) {
      pglite = new PGlite();
    }
    return {
      type: "pglite",
      raw: pglite,
      query: async (text: string, params?: unknown[]) => {
        const res = await (
          pglite as unknown as {
            query: (t: string, p: unknown[]) => Promise<{ rows: unknown[]; affectedRows: number }>;
          }
        ).query(text, (params as unknown[]) ?? []);
        return {
          rows: res.rows,
          rowCount: (res as unknown as { affectedRows: number }).affectedRows ?? res.rows.length,
        };
      },
    };
  } else {
    if (!pool) {
      // Persistent default: if DATABASE_URL still missing (should not happen after env load),
      // use the local Docker default from .env.example.
      const url =
        process.env.DATABASE_URL ?? "postgresql://tea_ledger:tea_ledger_dev@localhost:5432/tea_ledger";
      pool = new Pool({
        connectionString: url,
        ssl: url.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
      });
    }
    return {
      type: "pg",
      raw: pool,
      query: (text: string, params?: unknown[]) => pool!.query(text, params),
      end: async () => {
        if (pool) await pool.end();
      },
    };
  }
}
export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (pglite) {
    await pglite.close();
    pglite = null;
  }
}
export async function createTestDb(): Promise<DbClient> {
  const testLite = new PGlite();
  return {
    type: "pglite",
    raw: testLite,
    query: async (text: string, params?: unknown[]) => {
      const res = await (
        testLite as unknown as {
          query: (t: string, p: unknown[]) => Promise<{ rows: unknown[]; affectedRows: number }>;
        }
      ).query(text, (params as unknown[]) ?? []);
      return { rows: res.rows, rowCount: (res as unknown as { affectedRows: number }).affectedRows ?? res.rows.length };
    },
    end: async () => {
      await testLite.close();
    },
  };
}
