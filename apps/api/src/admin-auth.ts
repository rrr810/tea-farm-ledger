import type { FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "@tea-ledger/database";
import { createHash } from "node:crypto";

export type AdminFarmSession = {
  userId: string;
  username: string;
  role: "admin";
  farmId: string;
  expiresAt: string | Date;
};

function bearerToken(req: FastifyRequest): string {
  return String(req.headers.authorization ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

/** Admin session bearer values are never stored in cleartext in SQL. */
export function digestAdminSessionToken(token: string): string {
  return `admin:${createHash("sha256").update(token).digest("hex")}`;
}

/**
 * Validates an Admin session without making a farm decision. This is used only
 * for the farm-list endpoint; all farm-scoped routes must use requireAdminForFarm.
 */
export async function requireAdminSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AdminFarmSession | null> {
  const token = bearerToken(req);
  if (!token) {
    await reply.status(401).send({ error: "admin authentication required" });
    return null;
  }

  const db = await getDb();
  const result = await db.query(
    `SELECT s.expires_at, s.role AS session_role, u.user_id, u.username, u.role, u.farm_id
       FROM sessions s
       JOIN users u ON u.user_id=s.user_id
      WHERE s.token=$1
      LIMIT 1`,
    [digestAdminSessionToken(token)],
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
    session.role !== "admin" ||
    session.session_role !== "admin"
  ) {
    await reply.status(401).send({ error: "admin session is invalid or expired" });
    return null;
  }

  return {
    userId: session.user_id,
    username: session.username,
    role: "admin",
    farmId: session.farm_id,
    expiresAt: session.expires_at,
  };
}

/**
 * Sensitive data and controls are farm-bound. A valid account for another farm
 * is deliberately insufficient.
 */
export async function requireAdminForFarm(
  req: FastifyRequest,
  reply: FastifyReply,
  farmId: string,
): Promise<AdminFarmSession | null> {
  const session = await requireAdminSession(req, reply);
  if (!session) return null;
  if (session.farmId !== farmId) {
    await reply.status(403).send({ error: "admin access is not authorized for this farm" });
    return null;
  }
  return session;
}
