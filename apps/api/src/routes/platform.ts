import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getDb, type DbClient, withTransaction } from "@tea-ledger/database";
import { validateFarmName } from "@tea-ledger/core";
import {
  requireFarmAdminSession,
  type FarmAdminSession,
} from "../admin-auth.js";
import {
  PLATFORM_SESSION_MS,
  createPlatformSessionToken,
  digestPlatformSessionToken,
  hashPlatformPassword,
  normalizePlatformEmail,
  requirePlatformAdmin,
  validatePlatformPassword,
  verifyPlatformPasswordOrDummy,
} from "../platform-auth.js";
import {
  hashSupervisorPassword,
  normalizeSupervisorUsername,
} from "../supervisor-auth.js";

const DEFAULT_RATE_CENTS_PER_KG = 900;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

type LoginBody = { email?: unknown; password?: unknown };
type ActivateBody = LoginBody;
type CreateFarmBody = { farm_name?: unknown; supervisor_name?: unknown };
type CreateSupervisorBody = { supervisor_name?: unknown };

type PlatformAdminRow = {
  platform_admin_id: string;
  email: string;
  password_hash: string;
};

type LoginThrottleRow = {
  failed_attempts: number | string;
  window_started_at: string | Date;
  locked_until: string | Date | null;
};

class PlatformAlreadyActivatedError extends Error {}

function configuredBootstrapUsername(): string {
  // This is the existing production bootstrap Admin identity, not a new
  // environment value. Restricting initial activation to it prevents a random
  // farm Owner from claiming the whole console before the system owner does.
  return (process.env.ADMIN_USERNAME ?? "admin").trim().toLowerCase();
}

function isTrustedBootstrapAdmin(admin: FarmAdminSession): boolean {
  return admin.username.trim().toLowerCase() === configuredBootstrapUsername();
}

function isUniqueConstraintError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate?.code === "23505" ||
    /duplicate key|unique constraint|unique violation/i.test(String(candidate?.message ?? error))
  );
}

function retryAfterSeconds(lockedUntil: Date): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1_000));
}

function normalizedSupervisorName(value: unknown):
  | { ok: true; value: string }
  | { ok: false; reason: string } {
  if (typeof value !== "string") {
    return { ok: false, reason: "Supervisor name is required" };
  }
  const name = value.trim();
  if (!name || name.length > 80 || /[\u0000-\u001F\u007F]/.test(name)) {
    return { ok: false, reason: "enter a Supervisor name of up to 80 characters" };
  }
  return { ok: true, value: name };
}

/** Use a name only to make a friendly login suggestion; do not store it. */
function identifierStem(value: string, fallback: string): string {
  const stem = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return stem || fallback;
}

function candidateSupervisorUsername(farmName: string, supervisorName: string): string {
  const farmStem = identifierStem(farmName, "farm");
  const supervisorStem = identifierStem(supervisorName, "supervisor");
  // The random suffix makes the global username space safe without using a
  // personal name alone. Usernames are identifiers, not secrets.
  const suffix = randomBytes(3).toString("hex");
  const base = `farm-${farmStem}-${supervisorStem}`;
  const prefix = base.slice(0, 32 - suffix.length - 1).replace(/-+$/g, "") || "farm-supervisor";
  return `${prefix}-${suffix}`;
}

async function availableSupervisorUsername(
  db: DbClient,
  farmName: string,
  supervisorName: string,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = candidateSupervisorUsername(farmName, supervisorName);
    const normalized = normalizeSupervisorUsername(candidate);
    if (!normalized.ok) continue;
    const existing = await db.query(
      "SELECT user_id FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1",
      [normalized.value],
    );
    if ((existing.rows as unknown[]).length === 0) return normalized.value;
  }
  throw new Error("could not reserve a Supervisor username; try again");
}

/** 144 random bits, displayed only in the successful credential response. */
function generatedSupervisorPassword(): string {
  return randomBytes(18).toString("base64url");
}

async function platformAdminCount(db: DbClient): Promise<number> {
  const result = await db.query("SELECT COUNT(*)::int AS count FROM platform_admins");
  const value = (result.rows as Array<{ count: number | string }>)[0]?.count ?? 0;
  return Number(value);
}

async function platformLoginLock(db: DbClient, email: string): Promise<Date | null> {
  const result = await db.query(
    `SELECT failed_attempts, window_started_at, locked_until
       FROM platform_login_throttles
      WHERE email_canonical=$1`,
    [email],
  );
  const row = (result.rows as LoginThrottleRow[])[0];
  if (!row?.locked_until) return null;
  const lockedUntil = new Date(row.locked_until);
  return lockedUntil.getTime() > Date.now() ? lockedUntil : null;
}

async function notePlatformLoginFailure(db: DbClient, email: string): Promise<Date | null> {
  const result = await db.query(
    `INSERT INTO platform_login_throttles
       (email_canonical, failed_attempts, window_started_at, locked_until)
     VALUES ($1,1,NOW(),NULL)
     ON CONFLICT (email_canonical)
     DO UPDATE SET
       failed_attempts = CASE
         WHEN platform_login_throttles.window_started_at < NOW() - ($2 * INTERVAL '1 millisecond')
           THEN 1
         ELSE platform_login_throttles.failed_attempts + 1
       END,
       window_started_at = CASE
         WHEN platform_login_throttles.window_started_at < NOW() - ($2 * INTERVAL '1 millisecond')
           THEN NOW()
         ELSE platform_login_throttles.window_started_at
       END,
       locked_until = CASE
         WHEN (CASE
           WHEN platform_login_throttles.window_started_at < NOW() - ($2 * INTERVAL '1 millisecond')
             THEN 1
           ELSE platform_login_throttles.failed_attempts + 1
         END) >= $3 THEN NOW() + ($4 * INTERVAL '1 millisecond')
         ELSE NULL
       END
     RETURNING locked_until`,
    [email, LOGIN_WINDOW_MS, MAX_LOGIN_FAILURES, LOGIN_LOCK_MS],
  );
  const row = (result.rows as Array<{ locked_until: string | Date | null }>)[0];
  return row?.locked_until ? new Date(row.locked_until) : null;
}

async function issuePlatformSession(
  db: DbClient,
  platformAdminId: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = createPlatformSessionToken();
  const expiresAt = new Date(Date.now() + PLATFORM_SESSION_MS).toISOString();
  await db.query(
    `INSERT INTO platform_sessions (token, platform_admin_id, expires_at)
     VALUES ($1,$2,$3)`,
    [digestPlatformSessionToken(token), platformAdminId, expiresAt],
  );
  return { token, expiresAt };
}

async function auditPlatformAction(opts: {
  db: DbClient;
  farmId: string;
  actor: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}) {
  await opts.db.query(
    `INSERT INTO audit_log (farm_id, actor, action, target, detail)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [opts.farmId, opts.actor, opts.action, opts.target, JSON.stringify(opts.detail ?? {})],
  );
}

/** Central Master Admin authentication and farm provisioning. */
export async function platformRoutes(app: FastifyInstance) {
  /**
   * This returns no email, account count, or bootstrap identity. It only tells
   * the signed-in trusted legacy Admin whether it may perform the one-time
   * Master activation.
   */
  app.get("/api/platform/activation-status", async (req, reply) => {
    const admin = await requireFarmAdminSession(req, reply);
    if (!admin) return;
    const db = await getDb();
    const active = (await platformAdminCount(db)) > 0;
    return {
      master_active: active,
      can_activate: !active && isTrustedBootstrapAdmin(admin),
    };
  });

  /**
   * First and only Master Admin activation. It is reachable solely from the
   * configured, trusted existing Admin session and never through public signup.
   */
  app.post("/api/platform/activate", async (req, reply) => {
    const admin = await requireFarmAdminSession(req, reply);
    if (!admin) return;
    if (!isTrustedBootstrapAdmin(admin)) {
      return reply.status(403).send({ error: "this account is not authorized to activate the Master Console" });
    }

    const body = (req.body ?? {}) as ActivateBody;
    const email = normalizePlatformEmail(body.email);
    const password = validatePlatformPassword(body.password);
    if (!email.ok) return reply.status(400).send({ error: email.reason });
    if (!password.ok) return reply.status(400).send({ error: password.reason });

    const platformAdminId = randomUUID();
    const passwordHash = await hashPlatformPassword(password.value);
    try {
      const issued = await withTransaction(async (tx) => {
        if ((await platformAdminCount(tx)) > 0) throw new PlatformAlreadyActivatedError();
        await tx.query(
          `INSERT INTO platform_admins
             (platform_admin_id, email, email_canonical, password_hash, activated_by_user_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [platformAdminId, email.value, email.value, passwordHash, admin.userId],
        );
        const session = await issuePlatformSession(tx, platformAdminId);
        // Deliberately avoid recording the email or password in the farm audit
        // detail. The existing trusted Admin is the accountability actor.
        await auditPlatformAction({
          db: tx,
          farmId: admin.farmId,
          actor: admin.username,
          action: "platform_admin.activated",
          target: platformAdminId,
          detail: { activation: "trusted_existing_admin" },
        });
        return session;
      });
      return reply.status(201).send({
        ok: true,
        token: issued.token,
        role: "platform_admin",
        email: email.value,
        expires_at: issued.expiresAt,
      });
    } catch (error) {
      if (error instanceof PlatformAlreadyActivatedError || isUniqueConstraintError(error)) {
        return reply.status(409).send({ error: "the Master Console has already been activated" });
      }
      throw error;
    }
  });

  app.post("/api/platform/login", async (req, reply) => {
    const body = (req.body ?? {}) as LoginBody;
    const email = normalizePlatformEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    if (!email.ok || !password) {
      // Do a same-cost verification before a generic response so malformed and
      // absent accounts do not become an account-discovery oracle.
      await verifyPlatformPasswordOrDummy(password);
      return reply.status(401).send({ error: "invalid email or password" });
    }

    const db = await getDb();
    const lockedUntil = await platformLoginLock(db, email.value);
    if (lockedUntil) {
      return reply
        .header("Retry-After", String(retryAfterSeconds(lockedUntil)))
        .status(429)
        .send({ error: "too many sign-in attempts; try again later" });
    }

    const result = await db.query(
      `SELECT platform_admin_id, email, password_hash
         FROM platform_admins
        WHERE email_canonical=$1
        LIMIT 1`,
      [email.value],
    );
    const account = (result.rows as PlatformAdminRow[])[0];
    const valid = await verifyPlatformPasswordOrDummy(password, account?.password_hash);
    if (!account || !valid) {
      const newLock = await notePlatformLoginFailure(db, email.value);
      if (newLock) {
        return reply
          .header("Retry-After", String(retryAfterSeconds(newLock)))
          .status(429)
          .send({ error: "too many sign-in attempts; try again later" });
      }
      return reply.status(401).send({ error: "invalid email or password" });
    }

    await db.query("DELETE FROM platform_login_throttles WHERE email_canonical=$1", [email.value]);
    const issued = await issuePlatformSession(db, account.platform_admin_id);
    await db.query(
      "UPDATE platform_admins SET last_signed_in_at=NOW() WHERE platform_admin_id=$1",
      [account.platform_admin_id],
    );
    return {
      ok: true,
      token: issued.token,
      role: "platform_admin",
      email: account.email,
      expires_at: issued.expiresAt,
    };
  });

  /** Master-only creation: new farms receive a first Supervisor, not a local Owner. */
  app.post("/api/platform/farms", async (req, reply) => {
    const master = await requirePlatformAdmin(req, reply);
    if (!master) return;
    const body = (req.body ?? {}) as CreateFarmBody;
    const farmValidation = validateFarmName(typeof body.farm_name === "string" ? body.farm_name : "");
    const supervisorName = normalizedSupervisorName(body.supervisor_name);
    if (!farmValidation.valid) return reply.status(400).send({ error: farmValidation.reason });
    if (!supervisorName.ok) return reply.status(400).send({ error: supervisorName.reason });

    const name = (body.farm_name as string).trim();
    const db = await getDb();
    const sameName = await db.query(
      "SELECT farm_id FROM farms WHERE LOWER(BTRIM(name))=LOWER(BTRIM($1)) LIMIT 1",
      [name],
    );
    if ((sameName.rows as unknown[]).length > 0) {
      return reply.status(409).send({ error: "that official farm name is already registered; choose a different name" });
    }

    const farmId = randomUUID();
    const supervisorUserId = randomUUID();
    const supervisorUsername = await availableSupervisorUsername(db, name, supervisorName.value);
    const supervisorPassword = generatedSupervisorPassword();
    const supervisorPasswordHash = await hashSupervisorPassword(supervisorPassword);

    try {
      await withTransaction(async (tx) => {
        await tx.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [farmId, name]);
        await tx.query(
          "INSERT INTO farm_name_reservations (canonical_name, farm_id) VALUES (LOWER(BTRIM($1)),$2)",
          [name, farmId],
        );
        await tx.query(
          "INSERT INTO rates (farm_id, effective_from, rate_cents_per_kg) VALUES ($1,'2020-01-01',$2)",
          [farmId, DEFAULT_RATE_CENTS_PER_KG],
        );
        await tx.query(
          `INSERT INTO users (user_id, farm_id, role, username, password_hash)
           VALUES ($1,$2,'supervisor',$3,$4)`,
          [supervisorUserId, farmId, supervisorUsername, supervisorPasswordHash],
        );
        await auditPlatformAction({
          db: tx,
          farmId,
          actor: "master_admin",
          action: "farm.registered",
          target: farmId,
          detail: { setup: "master_console", initial_rate_cents_per_kg: DEFAULT_RATE_CENTS_PER_KG },
        });
        await auditPlatformAction({
          db: tx,
          farmId,
          actor: "master_admin",
          action: "supervisor.created",
          target: supervisorUserId,
          detail: { setup: "master_console_initial" },
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return reply.status(409).send({ error: "a farm name or Supervisor login is already in use; try again" });
      }
      throw error;
    }

    return reply.status(201).send({
      ok: true,
      farm_id: farmId,
      name,
      supervisor: {
        user_id: supervisorUserId,
        username: supervisorUsername,
        password: supervisorPassword,
      },
      initial_rate_cents_per_kg: DEFAULT_RATE_CENTS_PER_KG,
    });
  });

  /** Add another generated Supervisor credential to an existing Master-managed farm. */
  app.post("/api/platform/farms/:farmId/supervisors/generate", async (req, reply) => {
    const master = await requirePlatformAdmin(req, reply);
    if (!master) return;
    const { farmId } = req.params as { farmId: string };
    const body = (req.body ?? {}) as CreateSupervisorBody;
    const supervisorName = normalizedSupervisorName(body.supervisor_name);
    if (!supervisorName.ok) return reply.status(400).send({ error: supervisorName.reason });

    const db = await getDb();
    const farmResult = await db.query("SELECT farm_id, name FROM farms WHERE farm_id=$1 LIMIT 1", [farmId]);
    const farm = (farmResult.rows as Array<{ farm_id: string; name: string }>)[0];
    if (!farm) return reply.status(404).send({ error: "farm not found" });

    const userId = randomUUID();
    const username = await availableSupervisorUsername(db, farm.name, supervisorName.value);
    const password = generatedSupervisorPassword();
    const passwordHash = await hashSupervisorPassword(password);
    try {
      await withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO users (user_id, farm_id, role, username, password_hash)
           VALUES ($1,$2,'supervisor',$3,$4)`,
          [userId, farmId, username, passwordHash],
        );
        await auditPlatformAction({
          db: tx,
          farmId,
          actor: "master_admin",
          action: "supervisor.created",
          target: userId,
          detail: { setup: "master_console_generated" },
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return reply.status(409).send({ error: "a Supervisor login is already in use; try again" });
      }
      throw error;
    }
    return reply.status(201).send({
      user_id: userId,
      farm_id: farmId,
      username,
      password,
      role: "supervisor",
    });
  });

  /** Rotate a selected Supervisor to a fresh generated password, visible once. */
  app.post("/api/platform/farms/:farmId/supervisors/:userId/generate-password", async (req, reply) => {
    const master = await requirePlatformAdmin(req, reply);
    if (!master) return;
    const { farmId, userId } = req.params as { farmId: string; userId: string };
    const db = await getDb();
    const existing = await db.query(
      `SELECT username FROM users
        WHERE user_id=$1 AND farm_id=$2 AND role='supervisor' AND disabled_at IS NULL
        LIMIT 1`,
      [userId, farmId],
    );
    const supervisor = (existing.rows as Array<{ username: string }>)[0];
    if (!supervisor) return reply.status(404).send({ error: "Supervisor account not found" });

    const password = generatedSupervisorPassword();
    const passwordHash = await hashSupervisorPassword(password);
    await withTransaction(async (tx) => {
      await tx.query("UPDATE users SET password_hash=$1 WHERE user_id=$2", [passwordHash, userId]);
      // A rotation immediately invalidates identity sessions; field-device
      // device tokens remain farm-bound and retain their existing scope.
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
      await auditPlatformAction({
        db: tx,
        farmId,
        actor: "master_admin",
        action: "supervisor.password_rotated",
        target: userId,
        detail: { source: "master_console_generated" },
      });
    });
    return { ok: true, user_id: userId, username: supervisor.username, password };
  });

  /**
   * Replace a Supervisor without deleting the historical account. The former
   * credential, private-ID sessions, one-time pairing codes, and devices it
   * enrolled are revoked atomically before the new credential is returned.
   */
  app.post("/api/platform/farms/:farmId/supervisors/:userId/replace", async (req, reply) => {
    const master = await requirePlatformAdmin(req, reply);
    if (!master) return;
    const { farmId, userId } = req.params as { farmId: string; userId: string };
    const body = (req.body ?? {}) as CreateSupervisorBody;
    const supervisorName = normalizedSupervisorName(body.supervisor_name);
    if (!supervisorName.ok) return reply.status(400).send({ error: supervisorName.reason });

    const db = await getDb();
    const farmResult = await db.query("SELECT farm_id, name FROM farms WHERE farm_id=$1 LIMIT 1", [farmId]);
    const farm = (farmResult.rows as Array<{ farm_id: string; name: string }>)[0];
    if (!farm) return reply.status(404).send({ error: "farm not found" });
    const active = await db.query(
      `SELECT user_id FROM users
        WHERE user_id=$1 AND farm_id=$2 AND role='supervisor' AND disabled_at IS NULL
        LIMIT 1`,
      [userId, farmId],
    );
    if ((active.rows as unknown[]).length === 0) {
      return reply.status(404).send({ error: "active Supervisor account not found" });
    }

    const replacementUserId = randomUUID();
    const replacementUsername = await availableSupervisorUsername(db, farm.name, supervisorName.value);
    const replacementPassword = generatedSupervisorPassword();
    const replacementPasswordHash = await hashSupervisorPassword(replacementPassword);
    try {
      await withTransaction(async (tx) => {
        // A conditional update keeps two simultaneous replacement requests
        // from both deactivating the same account.
        const revoked = await tx.query(
          `UPDATE users
              SET disabled_at=NOW(), disabled_by_platform_admin_id=$1
            WHERE user_id=$2 AND farm_id=$3 AND role='supervisor' AND disabled_at IS NULL
          RETURNING user_id`,
          [master.platformAdminId, userId, farmId],
        );
        if ((revoked.rows as unknown[]).length === 0) {
          throw new Error("SUPERVISOR_ACCESS_ALREADY_REPLACED");
        }
        await tx.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
        await tx.query(
          "DELETE FROM supervisor_login_throttles WHERE farm_id=$1 AND username=(SELECT username FROM users WHERE user_id=$2)",
          [farmId, userId],
        );
        // Devices attached by the departed Supervisor must prove the new
        // Supervisor's credentials before they can resume field access.
        await tx.query(
          "UPDATE devices SET revoked=TRUE WHERE farm_id=$1 AND supervisor_user_id=$2",
          [farmId, userId],
        );
        await tx.query(
          "UPDATE field_device_link_codes SET expires_at=NOW() WHERE farm_id=$1 AND created_by_user_id=$2 AND consumed_at IS NULL",
          [farmId, userId],
        );
        await tx.query(
          `INSERT INTO users (user_id, farm_id, role, username, password_hash)
           VALUES ($1,$2,'supervisor',$3,$4)`,
          [replacementUserId, farmId, replacementUsername, replacementPasswordHash],
        );
        await auditPlatformAction({
          db: tx,
          farmId,
          actor: "master_admin",
          action: "supervisor.access_replaced",
          target: userId,
          detail: { replacement_user_id: replacementUserId },
        });
        await auditPlatformAction({
          db: tx,
          farmId,
          actor: "master_admin",
          action: "supervisor.created",
          target: replacementUserId,
          detail: { setup: "master_console_replacement" },
        });
      });
    } catch (error) {
      if (String((error as Error).message).includes("SUPERVISOR_ACCESS_ALREADY_REPLACED")) {
        return reply.status(409).send({ error: "that Supervisor access has already been replaced" });
      }
      if (isUniqueConstraintError(error)) {
        return reply.status(409).send({ error: "a Supervisor login is already in use; try again" });
      }
      throw error;
    }

    return reply.status(201).send({
      user_id: replacementUserId,
      farm_id: farmId,
      username: replacementUsername,
      password: replacementPassword,
      role: "supervisor",
      replaced_user_id: userId,
    });
  });
}
