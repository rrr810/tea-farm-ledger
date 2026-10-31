import type { FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "@tea-ledger/database";

export type AdminFarmSession = {
  userId: string;
  username: string;
  role: "admin";
  farmId: string;
};

/**
 * Sensitive worker identity endpoints are deliberately separate from the
 * supervisor/public worker list. They require a non-expired owner/admin
 * session bound to the requested farm and always fail closed.
 */
export async function requireAdminForFarm(
  req: FastifyRequest,
  reply: FastifyReply,
  farmId: string,
): Promise<AdminFarmSession | null> {
  const authorization = String(req.headers.authorization ?? "");
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    await reply.status(401).send({ error: "admin authentication required" });
    return null;
  }

  const db = await getDb();
  const result = await db.query(
    `SELECT s.expires_at, u.user_id, u.username, u.role, u.farm_id
       FROM sessions s
       JOIN users u ON u.user_id=s.user_id
      WHERE s.token=$1
      LIMIT 1`,
    [token],
  );
  const session = (result.rows as Array<{
    expires_at: string | Date;
    user_id: string;
    username: string;
    role: string;
    farm_id: string;
  }>)[0];

  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    await reply.status(401).send({ error: "admin session is invalid or expired" });
    return null;
  }
  if (session.role !== "admin" || session.farm_id !== farmId) {
    await reply.status(403).send({ error: "admin access is not authorized for this farm" });
    return null;
  }

  return {
    userId: session.user_id,
    username: session.username,
    role: "admin",
    farmId: session.farm_id,
  };
}
