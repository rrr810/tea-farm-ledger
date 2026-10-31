import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getDb, type DbClient, withTransaction } from "@tea-ledger/database";
import { requireAdminForFarm } from "../admin-auth.js";
import {
  hashSupervisorPassword,
  normalizeSupervisorUsername,
  validateSupervisorPassword,
} from "../supervisor-auth.js";

type SupervisorCredentialBody = {
  username?: string;
  password?: string;
};

async function auditSupervisorManagement(opts: {
  farmId: string;
  actor: string;
  action: "supervisor.created" | "supervisor.password_rotated";
  target: string;
  dbClient?: DbClient;
}) {
  const db = opts.dbClient ?? (await getDb());
  await db.query(
    `INSERT INTO audit_log (farm_id, actor, action, target, detail)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [opts.farmId, opts.actor, opts.action, opts.target, JSON.stringify({})],
  );
}

/** Admin-only provisioning for the Nandi supervisor's least-privilege account. */
export async function supervisorsRoutes(app: FastifyInstance) {
  app.get("/api/admin/farms/:farmId/supervisors", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const admin = await requireAdminForFarm(req, reply, farmId);
    if (!admin) return;
    const db = await getDb();
    const result = await db.query(
      `SELECT user_id, username, created_at
         FROM users
        WHERE farm_id=$1 AND role='supervisor'
        ORDER BY created_at ASC`,
      [farmId],
    );
    return { supervisors: result.rows };
  });

  app.post("/api/admin/farms/:farmId/supervisors", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const admin = await requireAdminForFarm(req, reply, farmId);
    if (!admin) return;
    const body = (req.body ?? {}) as SupervisorCredentialBody;
    const username = normalizeSupervisorUsername(body.username);
    const password = validateSupervisorPassword(body.password);
    if (!username.ok) {
      return reply.status(400).send({ error: username.reason });
    }
    if (!password.ok) {
      return reply.status(400).send({ error: password.reason });
    }

    const db = await getDb();
    const existing = await db.query(
      "SELECT user_id FROM users WHERE username=$1 LIMIT 1",
      [username.value],
    );
    if ((existing.rows as unknown[]).length > 0) {
      return reply.status(409).send({ error: "that supervisor username is already in use" });
    }

    const userId = randomUUID();
    const passwordHash = await hashSupervisorPassword(password.value);
    try {
      await withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO users (user_id, farm_id, role, username, password_hash)
           VALUES ($1,$2,'supervisor',$3,$4)`,
          [userId, farmId, username.value, passwordHash],
        );
        await auditSupervisorManagement({
          farmId,
          actor: admin.username,
          action: "supervisor.created",
          target: userId,
          dbClient: tx,
        });
      });
    } catch (error) {
      const message = String((error as Error).message ?? "").toLowerCase();
      if (message.includes("unique")) {
        return reply.status(409).send({ error: "that supervisor username is already in use" });
      }
      throw error;
    }
    return reply.status(201).send({
      user_id: userId,
      username: username.value,
      farm_id: farmId,
      role: "supervisor",
    });
  });

  app.post(
    "/api/admin/farms/:farmId/supervisors/:userId/reset-password",
    async (req, reply) => {
      const { farmId, userId } = req.params as { farmId: string; userId: string };
      const admin = await requireAdminForFarm(req, reply, farmId);
      if (!admin) return;
      const body = (req.body ?? {}) as SupervisorCredentialBody;
      const password = validateSupervisorPassword(body.password);
      if (!password.ok) return reply.status(400).send({ error: password.reason });

      const db = await getDb();
      const existing = await db.query(
        `SELECT user_id FROM users
          WHERE user_id=$1 AND farm_id=$2 AND role='supervisor'
          LIMIT 1`,
        [userId, farmId],
      );
      if ((existing.rows as unknown[]).length === 0) {
        return reply.status(404).send({ error: "supervisor account not found" });
      }
      const passwordHash = await hashSupervisorPassword(password.value);
      await withTransaction(async (tx) => {
        await tx.query("UPDATE users SET password_hash=$1 WHERE user_id=$2", [
          passwordHash,
          userId,
        ]);
        // A reset immediately invalidates every previous private-ID session.
        await tx.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
        await auditSupervisorManagement({
          farmId,
          actor: admin.username,
          action: "supervisor.password_rotated",
          target: userId,
          dbClient: tx,
        });
      });
      return { ok: true };
    },
  );
}
