import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getDb, type DbClient } from "@tea-ledger/database";

const scrypt = promisify(scryptCallback);
const SCRYPT_KEY_BYTES = 64;
export const PLATFORM_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
// Keeps absent-email and wrong-password checks on the same scrypt path.
const DUMMY_PLATFORM_PASSWORD_HASH =
  "scrypt-v1$YXJlbi1zdXBlcnZpc29yLWR1bW15$aGtgK5s19_DpO5RRmoMBMb625pVzFjdkru5zkL4UtBw7y84fLxLwMLWMWP4ZSi9SRtmrPbURcNvkOycC8R-rLQ";

export type PlatformAdminSession = {
  kind: "platform";
  platformAdminId: string;
  email: string;
  role: "platform_admin";
  expiresAt: string | Date;
};

type PlatformSessionRow = {
  expires_at: string | Date;
  platform_admin_id: string;
  email: string;
};

function bearerToken(req: FastifyRequest): string {
  return String(req.headers.authorization ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

/** The browser receives this opaque token once; SQL stores only its digest. */
export function createPlatformSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function digestPlatformSessionToken(token: string): string {
  return `platform:${createHash("sha256").update(token).digest("hex")}`;
}

export function normalizePlatformEmail(value: unknown):
  | { ok: true; value: string }
  | { ok: false; reason: string } {
  if (typeof value !== "string") {
    return { ok: false, reason: "email address is required" };
  }
  const email = value.trim().toLowerCase();
  // This deliberately modest check rejects control characters and malformed
  // identifiers without pretending to validate every possible mail server.
  if (
    email.length < 6 ||
    email.length > 254 ||
    /[\u0000-\u001F\u007F\s]/.test(email) ||
    !/^[^@]+@[^@]+\.[^@]+$/.test(email)
  ) {
    return { ok: false, reason: "enter a valid email address" };
  }
  return { ok: true, value: email };
}

export function validatePlatformPassword(value: unknown):
  | { ok: true; value: string }
  | { ok: false; reason: string } {
  if (typeof value !== "string") {
    return { ok: false, reason: "Master password is required" };
  }
  if (value.length < 12 || value.length > 128) {
    return { ok: false, reason: "Master password must be 12–128 characters" };
  }
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    return { ok: false, reason: "Master password contains unsupported characters" };
  }
  return { ok: true, value };
}

/** Master passwords use a versioned scrypt hash and are never logged or returned. */
export async function hashPlatformPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const derived = (await scrypt(password, salt, SCRYPT_KEY_BYTES)) as Buffer;
  return `scrypt-v1$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPlatformPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [version, salt, encodedExpected, ...extra] = storedHash.split("$");
  if (version !== "scrypt-v1" || !salt || !encodedExpected || extra.length > 0) {
    return false;
  }
  try {
    const expected = Buffer.from(encodedExpected, "base64url");
    const actual = (await scrypt(password, salt, expected.length)) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export async function verifyPlatformPasswordOrDummy(
  password: string,
  storedHash?: string,
): Promise<boolean> {
  return verifyPlatformPassword(password, storedHash ?? DUMMY_PLATFORM_PASSWORD_HASH);
}

export async function currentPlatformAdminSession(
  token: string,
  dbClient?: DbClient,
): Promise<PlatformAdminSession | null> {
  if (!token) return null;
  const db = dbClient ?? (await getDb());
  const result = await db.query(
    `SELECT ps.expires_at, p.platform_admin_id, p.email
       FROM platform_sessions ps
       JOIN platform_admins p ON p.platform_admin_id=ps.platform_admin_id
      WHERE ps.token=$1
      LIMIT 1`,
    [digestPlatformSessionToken(token)],
  );
  const session = (result.rows as PlatformSessionRow[])[0];
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
  return {
    kind: "platform",
    platformAdminId: session.platform_admin_id,
    email: session.email,
    role: "platform_admin",
    expiresAt: session.expires_at,
  };
}

export async function requirePlatformAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<PlatformAdminSession | null> {
  const session = await currentPlatformAdminSession(bearerToken(req));
  if (!session) {
    await reply.status(401).send({ error: "Master Admin authentication required" });
    return null;
  }
  return session;
}
