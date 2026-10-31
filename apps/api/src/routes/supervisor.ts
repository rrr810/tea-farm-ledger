import type { FastifyInstance } from "fastify";
import { getDb, type DbClient, withTransaction } from "@tea-ledger/database";
import {
  SUPERVISOR_SESSION_MS,
  clearSupervisorLoginFailures,
  createSupervisorSessionToken,
  currentSupervisorSession,
  digestSupervisorSessionToken,
  noteSupervisorLoginFailure,
  normalizeSupervisorUsername,
  requireSupervisorForFarm,
  supervisorLoginLock,
  verifySupervisorPasswordOrDummy,
} from "../supervisor-auth.js";

type SupervisorLoginBody = {
  farm_id?: string;
  username?: string;
  password?: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function retryAfterSeconds(until: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000));
}

async function auditSupervisorLogin(opts: {
  farmId: string;
  actor: string;
  action: "supervisor.login" | "supervisor.logout";
  dbClient?: DbClient;
}) {
  const db = opts.dbClient ?? (await getDb());
  await db.query(
    `INSERT INTO audit_log (farm_id, actor, action, target, detail)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [opts.farmId, opts.actor, opts.action, null, JSON.stringify({})],
  );
}

/**
 * Supervisor credentials are provisioned by a farm-bound Admin. These routes
 * are intentionally separate from the Admin dashboard login so the field PWA
 * gets a short-lived, least-privilege session only for private ID intake.
 */
export async function supervisorRoutes(app: FastifyInstance) {
  app.post("/api/supervisor/login", async (req, reply) => {
    const body = (req.body ?? {}) as SupervisorLoginBody;
    const farmId = typeof body.farm_id === "string" ? body.farm_id.trim() : "";
    const normalized = normalizeSupervisorUsername(body.username);
    if (!farmId || !normalized.ok || typeof body.password !== "string") {
      return reply.status(400).send({
        error: normalized.ok
          ? "farm_id, username, and password are required"
          : normalized.reason,
      });
    }
    if (!UUID_PATTERN.test(farmId)) {
      return reply.status(400).send({ error: "farm_id must be a valid UUID" });
    }

    const db = await getDb();
    const farm = await db.query("SELECT farm_id FROM farms WHERE farm_id=$1 LIMIT 1", [
      farmId,
    ]);
    if ((farm.rows as unknown[]).length === 0) {
      // Preserve the same password-verification cost without revealing whether
      // a guessed farm is registered or triggering a foreign-key error.
      await verifySupervisorPasswordOrDummy(body.password);
      return reply.status(401).send({ error: "invalid supervisor credentials" });
    }
    const lockedUntil = await supervisorLoginLock(db, farmId, normalized.value);
    if (lockedUntil) {
      return reply
        .header("Retry-After", String(retryAfterSeconds(lockedUntil)))
        .status(429)
        .send({ error: "too many sign-in attempts; try again later" });
    }

    const result = await db.query(
      `SELECT user_id, farm_id, username, role, password_hash
         FROM users
        WHERE farm_id=$1 AND username=$2 AND role='supervisor'
        LIMIT 1`,
      [farmId, normalized.value],
    );
    const user = (result.rows as Array<{
      user_id: string;
      farm_id: string;
      username: string;
      role: string;
      password_hash: string;
    }>)[0];
    // Verify a fixed dummy hash too when the username is absent, preventing a
    // low-cost timing oracle for which Supervisor accounts exist.
    const passwordMatches = await verifySupervisorPasswordOrDummy(
      body.password,
      user?.password_hash,
    );
    const valid = Boolean(user) && passwordMatches;
    if (!valid || !user) {
      const lock = await noteSupervisorLoginFailure(db, farmId, normalized.value);
      if (lock) {
        return reply
          .header("Retry-After", String(retryAfterSeconds(lock)))
          .status(429)
          .send({ error: "too many sign-in attempts; try again later" });
      }
      // Do not distinguish a missing account from a wrong password.
      return reply.status(401).send({ error: "invalid supervisor credentials" });
    }

    await clearSupervisorLoginFailures(db, farmId, normalized.value);
    const token = createSupervisorSessionToken();
    const tokenDigest = digestSupervisorSessionToken(token);
    const expiresAt = new Date(Date.now() + SUPERVISOR_SESSION_MS).toISOString();
    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO sessions (token, user_id, farm_id, role, expires_at)
         VALUES ($1,$2,$3,'supervisor',$4)`,
        [tokenDigest, user.user_id, user.farm_id, expiresAt],
      );
      await auditSupervisorLogin({
        farmId: user.farm_id,
        actor: user.username,
        action: "supervisor.login",
        dbClient: tx,
      });
    });
    return {
      ok: true,
      token,
      username: user.username,
      farm_id: user.farm_id,
      role: "supervisor",
      expires_at: expiresAt,
    };
  });

  app.get("/api/supervisor/me", async (req, reply) => {
    const token = String(req.headers.authorization ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    const session = await currentSupervisorSession(token);
    if (!session) return reply.status(401).send({ error: "supervisor session is invalid or expired" });
    return {
      ok: true,
      username: session.username,
      farm_id: session.farmId,
      role: session.role,
      expires_at: session.expiresAt,
    };
  });

  app.post("/api/supervisor/logout", async (req, reply) => {
    const token = String(req.headers.authorization ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    const session = await currentSupervisorSession(token);
    if (token) {
      await withTransaction(async (tx) => {
        await tx.query("DELETE FROM sessions WHERE token=$1", [
          digestSupervisorSessionToken(token),
        ]);
        if (session) {
          await auditSupervisorLogin({
            farmId: session.farmId,
            actor: session.username,
            action: "supervisor.logout",
            dbClient: tx,
          });
        }
      });
    }
    return reply.send({ ok: true });
  });

  // This defensive self-check route is intentionally farm-bound and can be
  // used by the PWA before enabling private-ID tools.
  app.get("/api/supervisor/farms/:farmId/access", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const session = await requireSupervisorForFarm(req, reply, farmId);
    if (!session) return;
    return {
      ok: true,
      username: session.username,
      farm_id: session.farmId,
      expires_at: session.expiresAt,
    };
  });
}
