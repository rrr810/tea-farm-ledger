import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getDb, type DbClient } from "@tea-ledger/database";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DeviceAccessRow = {
  device_id: string;
  farm_id: string;
  supervisor_user_id: string | null;
  revoked: boolean;
};

export type FarmDeviceAccess = {
  deviceId: string;
  farmId: string;
  supervisorUserId: string | null;
};

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** A random bearer credential is returned once to the enrolled browser. */
export function createDeviceAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Store only a domain-separated digest, never the browser-held token. */
export function digestDeviceAccessToken(token: string): string {
  return `device:${createHash("sha256").update(token).digest("hex")}`;
}

/**
 * Enrols a device in one farm, or rotates that device's credential after an
 * authorized Supervisor/Admin re-enrolment. A device ID can never be rebound
 * from one farm to another by this helper.
 */
export async function issueFarmDeviceAccess(opts: {
  farmId: string;
  deviceId: string;
  supervisorUserId?: string | null;
  dbClient?: DbClient;
}): Promise<{ deviceToken: string }> {
  if (!isUuid(opts.farmId) || !isUuid(opts.deviceId)) {
    throw new Error("invalid farm or device identifier");
  }
  const db = opts.dbClient ?? (await getDb());
  const deviceToken = createDeviceAccessToken();
  const digest = digestDeviceAccessToken(deviceToken);
  const result = await db.query(
    `INSERT INTO devices
       (device_id, farm_id, supervisor_user_id, access_token_hash,
        access_token_issued_at, access_token_last_used_at, revoked, last_seen)
     VALUES ($1,$2,$3,$4,NOW(),NOW(),false,NOW())
     ON CONFLICT (device_id)
     DO UPDATE SET
       access_token_hash=EXCLUDED.access_token_hash,
       access_token_issued_at=NOW(),
       access_token_last_used_at=NOW(),
       supervisor_user_id=COALESCE(EXCLUDED.supervisor_user_id, devices.supervisor_user_id),
       revoked=false,
       last_seen=NOW()
     WHERE devices.farm_id=EXCLUDED.farm_id
     RETURNING device_id`,
    [opts.deviceId, opts.farmId, opts.supervisorUserId ?? null, digest],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error("this device is already enrolled to a different farm");
  }
  return { deviceToken };
}

function header(req: FastifyRequest, name: string): string {
  const raw = req.headers[name] as string | string[] | undefined;
  return (Array.isArray(raw) ? raw[0] : raw ?? "").trim();
}

/**
 * A field-device request must prove possession of both its opaque token and its
 * device ID, and that pair must be bound to the requested farm.
 */
export async function requireFarmDevice(
  req: FastifyRequest,
  reply: FastifyReply,
  farmId: string,
): Promise<FarmDeviceAccess | null> {
  const deviceId = header(req, "x-tea-device-id");
  const token = header(req, "x-tea-device-token");
  if (!isUuid(farmId) || !isUuid(deviceId) || !token) {
    await reply.status(401).send({ error: "field device authentication required" });
    return null;
  }

  const db = await getDb();
  const result = await db.query(
    `SELECT device_id, farm_id, supervisor_user_id, revoked
       FROM devices
      WHERE device_id=$1 AND farm_id=$2 AND access_token_hash=$3
      LIMIT 1`,
    [deviceId, farmId, digestDeviceAccessToken(token)],
  );
  const device = (result.rows as DeviceAccessRow[])[0];
  if (!device || device.revoked) {
    await reply.status(401).send({ error: "field device is not authorized for this farm" });
    return null;
  }

  await db.query(
    "UPDATE devices SET last_seen=NOW(), access_token_last_used_at=NOW() WHERE device_id=$1",
    [deviceId],
  );
  return {
    deviceId: device.device_id,
    farmId: device.farm_id,
    supervisorUserId: device.supervisor_user_id,
  };
}
