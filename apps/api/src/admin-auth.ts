import type { FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "@tea-ledger/database";
import { createHash } from "node:crypto";
import {
  currentPlatformAdminSession,
  type PlatformAdminSession,
} from "./platform-auth.js";

/** A legacy, farm-bound Owner/Admin browser session. */
export type FarmAdminSession = {
  kind: "farm";
  userId: string;
  username: string;
  role: "admin";
  farmId: string;
  expiresAt: string | Date;
};

/**
 * A Principal who has been authorized for one concrete farm route. A Master
 * Admin is deliberately represented with no farm-user ID: routes must not
 * accidentally write that platform identity into a foreign key to `users`.
 */
export type AdminFarmSession = {
  userId: string | null;
  platformAdminId?: string;
  username: string;
  role: "admin";
  farmId: string;
  expiresAt: string | Date;
  isPlatformAdmin: boolean;
};

export type AnyAdminSession = FarmAdminSession | PlatformAdminSession;

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
 * Validates either a farm Owner/Admin session or the central Master Admin
 * session. Farm-scoped callers must still use requireAdminForFarm below.
 */
export async function requireAdminSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AnyAdminSession | null> {
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
    session &&
    new Date(session.expires_at).getTime() > Date.now() &&
    session.role === "admin" &&
    session.session_role === "admin"
  ) {
    return {
      kind: "farm",
      userId: session.user_id,
      username: session.username,
      role: "admin",
      farmId: session.farm_id,
      expiresAt: session.expires_at,
    };
  }

  const platformSession = await currentPlatformAdminSession(token, db);
  if (platformSession) return platformSession;

  await reply.status(401).send({ error: "admin session is invalid or expired" });
  return null;
}

/** A route that must be initiated by a retained farm-specific Owner/Admin. */
export async function requireFarmAdminSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FarmAdminSession | null> {
  const session = await requireAdminSession(req, reply);
  if (!session) return null;
  if (session.kind !== "farm") {
    await reply.status(403).send({ error: "this setup action requires the trusted existing Admin account" });
    return null;
  }
  return session;
}

/**
 * Sensitive data and controls are farm-bound for ordinary Owners. The central
 * Master Admin may deliberately enter any existing farm without pretending to
 * be a farm user; its farm audit actor is a non-email Master label.
 */
export async function requireAdminForFarm(
  req: FastifyRequest,
  reply: FastifyReply,
  farmId: string,
): Promise<AdminFarmSession | null> {
  const session = await requireAdminSession(req, reply);
  if (!session) return null;

  if (session.kind === "platform") {
    const db = await getDb();
    const farm = await db.query("SELECT farm_id FROM farms WHERE farm_id=$1 LIMIT 1", [farmId]);
    if ((farm.rows as unknown[]).length === 0) {
      await reply.status(404).send({ error: "farm not found" });
      return null;
    }
    return {
      userId: null,
      platformAdminId: session.platformAdminId,
      // Farm Owners can read their own audit log. Record a distinct Master
      // actor without leaking the Master sign-in email into that farm record.
      username: "master_admin",
      role: "admin",
      farmId,
      expiresAt: session.expiresAt,
      isPlatformAdmin: true,
    };
  }

  if (session.farmId !== farmId) {
    await reply.status(403).send({ error: "admin access is not authorized for this farm" });
    return null;
  }
  return {
    userId: session.userId,
    username: session.username,
    role: "admin",
    farmId: session.farmId,
    expiresAt: session.expiresAt,
    isPlatformAdmin: false,
  };
}
