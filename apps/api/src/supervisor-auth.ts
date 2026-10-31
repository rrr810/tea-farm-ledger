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
export const SUPERVISOR_SESSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
// Keeps missing-account and wrong-password attempts on the same scrypt path.
const DUMMY_PASSWORD_HASH =
  "scrypt-v1$YXJlbi1zdXBlcnZpc29yLWR1bW15$aGtgK5s19_DpO5RRmoMBMb625pVzFjdkru5zkL4UtBw7y84fLxLwMLWMWP4ZSi9SRtmrPbURcNvkOycC8R-rLQ";

export type SupervisorFarmSession = {
  userId: string;
  username: string;
  role: "supervisor";
  farmId: string;
  expiresAt: string | Date;
};

type LoginThrottleRow = {
  failed_attempts: number | string;
  window_started_at: string | Date;
  locked_until: string | Date | null;
};

function bearerToken(req: FastifyRequest): string {
  return String(req.headers.authorization ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

export function normalizeSupervisorUsername(value: unknown):
  | { ok: true; value: string }
  | { ok: false; reason: string } {
  if (typeof value !== "string") {
    return { ok: false, reason: "supervisor username is required" };
  }
  const username = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{2,31}$/.test(username)) {
    return {
      ok: false,
      reason:
        "supervisor username must be 3–32 lowercase letters, numbers, dots, dashes, or underscores",
    };
  }
  return { ok: true, value: username };
}

export function validateSupervisorPassword(value: unknown):
  | { ok: true; value: string }
  | { ok: false; reason: string } {
  if (typeof value !== "string") {
    return { ok: false, reason: "supervisor password is required" };
  }
  if (value.length < 12 || value.length > 128) {
    return { ok: false, reason: "supervisor password must be 12–128 characters" };
  }
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    return { ok: false, reason: "supervisor password contains unsupported characters" };
  }
  return { ok: true, value };
}

/** Passwords are stored with a versioned scrypt hash, never as plaintext. */
export async function hashSupervisorPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const derived = (await scrypt(password, salt, SCRYPT_KEY_BYTES)) as Buffer;
  return `scrypt-v1$${salt}$${derived.toString("base64url")}`;
}

export async function verifySupervisorPassword(
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

export async function verifySupervisorPasswordOrDummy(
  password: string,
  storedHash?: string,
): Promise<boolean> {
  return verifySupervisorPassword(password, storedHash ?? DUMMY_PASSWORD_HASH);
}

export function createSupervisorSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Store only a one-way, role-domain-separated session token digest in SQL. */
export function digestSupervisorSessionToken(token: string): string {
  return `supervisor:${createHash("sha256").update(token).digest("hex")}`;
}

export async function requireSupervisorForFarm(
  req: FastifyRequest,
  reply: FastifyReply,
  farmId: string,
): Promise<SupervisorFarmSession | null> {
  const token = bearerToken(req);
  if (!token) {
    await reply.status(401).send({ error: "supervisor authentication required" });
    return null;
  }

  const db = await getDb();
  const tokenDigest = digestSupervisorSessionToken(token);
  const result = await db.query(
    `SELECT s.expires_at, s.role AS session_role, u.user_id, u.username, u.role, u.farm_id
       FROM sessions s
       JOIN users u ON u.user_id=s.user_id
      WHERE s.token=$1
      LIMIT 1`,
    [tokenDigest],
  );
  const session = (result.rows as Array<{
    expires_at: string | Date;
    session_role: string;
    user_id: string;
    username: string;
    role: string;
    farm_id: string;
  }>)[0];

  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    await reply.status(401).send({ error: "supervisor session is invalid or expired" });
    return null;
  }
  if (
    session.role !== "supervisor" ||
    session.session_role !== "supervisor" ||
    session.farm_id !== farmId
  ) {
    await reply.status(403).send({ error: "supervisor access is not authorized for this farm" });
    return null;
  }

  return {
    userId: session.user_id,
    username: session.username,
    role: "supervisor",
    farmId: session.farm_id,
    expiresAt: session.expires_at,
  };
}

export async function currentSupervisorSession(
  token: string,
  dbClient?: DbClient,
): Promise<SupervisorFarmSession | null> {
  if (!token) return null;
  const db = dbClient ?? (await getDb());
  const tokenDigest = digestSupervisorSessionToken(token);
  const result = await db.query(
    `SELECT s.expires_at, s.role AS session_role, u.user_id, u.username, u.role, u.farm_id
       FROM sessions s
       JOIN users u ON u.user_id=s.user_id
      WHERE s.token=$1
      LIMIT 1`,
    [tokenDigest],
  );
  const session = (result.rows as Array<{
    expires_at: string | Date;
    session_role: string;
    user_id: string;
    username: string;
    role: string;
    farm_id: string;
  }>)[0];
  if (
    !session ||
    new Date(session.expires_at).getTime() <= Date.now() ||
    session.role !== "supervisor" ||
    session.session_role !== "supervisor"
  ) {
    return null;
  }
  return {
    userId: session.user_id,
    username: session.username,
    role: "supervisor",
    farmId: session.farm_id,
    expiresAt: session.expires_at,
  };
}

export async function supervisorLoginLock(
  db: DbClient,
  farmId: string,
  username: string,
): Promise<Date | null> {
  const result = await db.query(
    `SELECT failed_attempts, window_started_at, locked_until
       FROM supervisor_login_throttles
      WHERE farm_id=$1 AND username=$2`,
    [farmId, username],
  );
  const row = (result.rows as LoginThrottleRow[])[0];
  if (!row?.locked_until) return null;
  const lockedUntil = new Date(row.locked_until);
  return lockedUntil.getTime() > Date.now() ? lockedUntil : null;
}

export async function noteSupervisorLoginFailure(
  db: DbClient,
  farmId: string,
  username: string,
): Promise<Date | null> {
  // One UPSERT makes the increment atomic. Parallel bad-password requests
  // cannot all read the same old count and evade the lock threshold.
  const result = await db.query(
    `INSERT INTO supervisor_login_throttles
       (farm_id, username, failed_attempts, window_started_at, locked_until)
     VALUES ($1,$2,1,NOW(),NULL)
     ON CONFLICT (farm_id, username)
     DO UPDATE SET
       failed_attempts = CASE
         WHEN supervisor_login_throttles.window_started_at < NOW() - ($3 * INTERVAL '1 millisecond')
           THEN 1
         ELSE supervisor_login_throttles.failed_attempts + 1
       END,
       window_started_at = CASE
         WHEN supervisor_login_throttles.window_started_at < NOW() - ($3 * INTERVAL '1 millisecond')
           THEN NOW()
         ELSE supervisor_login_throttles.window_started_at
       END,
       locked_until = CASE
         WHEN (CASE
           WHEN supervisor_login_throttles.window_started_at < NOW() - ($3 * INTERVAL '1 millisecond')
             THEN 1
           ELSE supervisor_login_throttles.failed_attempts + 1
         END) >= $4 THEN NOW() + ($5 * INTERVAL '1 millisecond')
         ELSE NULL
       END
     RETURNING locked_until`,
    [farmId, username, LOGIN_WINDOW_MS, MAX_LOGIN_FAILURES, LOGIN_LOCK_MS],
  );
  const row = (result.rows as Array<{ locked_until: string | Date | null }>)[0];
  return row?.locked_until ? new Date(row.locked_until) : null;
}

export async function clearSupervisorLoginFailures(
  db: DbClient,
  farmId: string,
  username: string,
): Promise<void> {
  await db.query(
    "DELETE FROM supervisor_login_throttles WHERE farm_id=$1 AND username=$2",
    [farmId, username],
  );
}
