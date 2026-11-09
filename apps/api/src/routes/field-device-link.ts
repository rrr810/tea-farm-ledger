import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getDb, type DbClient, withTransaction } from "@tea-ledger/database";
import { requireAdminForFarm } from "../admin-auth.js";
import {
  createDeviceAccessToken,
  digestDeviceAccessToken,
  isUuid,
} from "../device-auth.js";
import {
  SUPERVISOR_SESSION_MS,
  clearSupervisorLoginFailures,
  createSupervisorSessionToken,
  digestSupervisorSessionToken,
  normalizeSupervisorUsername,
  noteSupervisorLoginFailure,
  supervisorLoginLock,
  verifySupervisorPasswordOrDummy,
} from "../supervisor-auth.js";

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const INVALID_LINK_CODE_MESSAGE = "link code is invalid, expired, or already used";
const INVALID_JOIN_MESSAGE = "farm name or supervisor credentials are invalid";

type CreateLinkCodeBody = Record<string, never>;
type ConsumeLinkCodeBody = {
  code?: unknown;
  device_id?: unknown;
};
type JoinExistingFarmBody = {
  farm_name?: unknown;
  username?: unknown;
  password?: unknown;
  device_id?: unknown;
  // An already-bound browser proves possession of its current credential
  // before it can be moved. A truly new browser has no existing device row.
  current_device_token?: unknown;
};

type ConsumedCodeRow = {
  code_id: string;
  farm_id: string;
};
type FarmRow = {
  farm_id: string;
  name: string;
};
type ExistingDeviceRow = {
  farm_id: string | null;
  access_token_hash: string | null;
  revoked: boolean | null;
};
type SupervisorRow = {
  user_id: string;
  farm_id: string;
  username: string;
  password_hash: string;
};

type FieldDeviceLinkAudit = {
  actor: string;
  targetAction: string;
  targetDetail: Record<string, unknown>;
  sourceReason: string;
};

function createLinkCode(): string {
  // 192 random bits, shown only once to the authenticated Owner/Admin. This is
  // an authorisation secret, not a farm identifier, and is deliberately short
  // lived and single use.
  return `TL-${randomBytes(24).toString("base64url")}`;
}

function digestLinkCode(code: string): string {
  return `field-device-link:${createHash("sha256").update(code).digest("hex")}`;
}

function suppliedLinkCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim();
  return code.length >= 24 && code.length <= 160 ? code : null;
}

function suppliedFarmName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 80 ? name : null;
}

function retryAfterSeconds(until: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000));
}

function tokenMatchesStoredDigest(token: unknown, storedDigest: string | null): boolean {
  if (typeof token !== "string" || !token || !storedDigest) return false;
  const suppliedDigest = digestDeviceAccessToken(token);
  const expected = Buffer.from(storedDigest, "utf8");
  const supplied = Buffer.from(suppliedDigest, "utf8");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

async function auditFieldDeviceLink(opts: {
  farmId: string;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  dbClient: DbClient;
}): Promise<void> {
  await opts.dbClient.query(
    `INSERT INTO audit_log (farm_id, actor, action, target, detail)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [
      opts.farmId,
      opts.actor,
      opts.action,
      opts.target,
      JSON.stringify(opts.detail),
    ],
  );
}

/**
 * Gives the exact field-browser ID a fresh opaque credential for `farm`. A
 * caller either proves physical possession of the old credential (Supervisor
 * join path) or holds the Owner-generated one-time pairing secret (code path).
 * No worker, kg, payroll, SMS, or other tenant record is moved.
 */
async function linkDeviceToFarm(opts: {
  tx: DbClient;
  farm: FarmRow;
  deviceId: string;
  existingDevice?: ExistingDeviceRow;
  audit: FieldDeviceLinkAudit;
}): Promise<string> {
  const existing =
    opts.existingDevice ??
    ((await opts.tx.query(
      "SELECT farm_id, access_token_hash, revoked FROM devices WHERE device_id=$1 FOR UPDATE",
      [opts.deviceId],
    )).rows as ExistingDeviceRow[])[0];
  const deviceToken = createDeviceAccessToken();
  const tokenHash = digestDeviceAccessToken(deviceToken);

  if (existing) {
    if (existing.farm_id && existing.farm_id !== opts.farm.farm_id) {
      // Do not expose the target farm in an old farm's audit history.
      await auditFieldDeviceLink({
        farmId: existing.farm_id,
        actor: opts.audit.actor,
        action: "field_device.unlinked",
        target: opts.deviceId,
        detail: { reason: opts.audit.sourceReason },
        dbClient: opts.tx,
      });
    }
    await opts.tx.query(
      `UPDATE devices
          SET farm_id=$2,
              supervisor_user_id=NULL,
              access_token_hash=$3,
              access_token_issued_at=NOW(),
              access_token_last_used_at=NOW(),
              revoked=false,
              last_seen=NOW(),
              enrolled_at=NOW()
        WHERE device_id=$1`,
      [opts.deviceId, opts.farm.farm_id, tokenHash],
    );
  } else {
    await opts.tx.query(
      `INSERT INTO devices
         (device_id, farm_id, supervisor_user_id, access_token_hash,
          access_token_issued_at, access_token_last_used_at, revoked, last_seen)
       VALUES ($1,$2,NULL,$3,NOW(),NOW(),false,NOW())`,
      [opts.deviceId, opts.farm.farm_id, tokenHash],
    );
  }

  await auditFieldDeviceLink({
    farmId: opts.farm.farm_id,
    actor: opts.audit.actor,
    action: opts.audit.targetAction,
    target: opts.deviceId,
    detail: opts.audit.targetDetail,
    dbClient: opts.tx,
  });
  return deviceToken;
}

/**
 * An Owner/Admin issues a one-time pairing code from the same farm that will
 * receive the field device. The plaintext is returned once and is never stored.
 */
export async function fieldDeviceLinkRoutes(app: FastifyInstance) {
  app.post("/api/admin/farms/:farmId/field-device-link-codes", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const admin = await requireAdminForFarm(req, reply, farmId);
    if (!admin) return;
    // Keep the declared empty body type explicit: no caller can lengthen the
    // expiry, select a different farm, or otherwise widen this capability.
    void (req.body as CreateLinkCodeBody | undefined);

    const codeId = randomUUID();
    const code = createLinkCode();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
    await withTransaction(async (tx) => {
      if (admin.platformAdminId) {
        await tx.query(
          `INSERT INTO field_device_link_codes
             (code_id, farm_id, created_by_user_id, created_by_platform_admin_id, code_hash, expires_at)
           VALUES ($1,$2,NULL,$3,$4,$5)`,
          [codeId, farmId, admin.platformAdminId, digestLinkCode(code), expiresAt],
        );
      } else {
        await tx.query(
          `INSERT INTO field_device_link_codes
             (code_id, farm_id, created_by_user_id, created_by_platform_admin_id, code_hash, expires_at)
           VALUES ($1,$2,$3,NULL,$4,$5)`,
          [codeId, farmId, admin.userId, digestLinkCode(code), expiresAt],
        );
      }
      await auditFieldDeviceLink({
        farmId,
        actor: admin.username,
        action: "field_device.link_code_created",
        target: codeId,
        detail: { expires_in_minutes: LINK_CODE_TTL_MS / 60_000 },
        dbClient: tx,
      });
    });

    return reply.status(201).send({
      code,
      expires_at: expiresAt,
      expires_in_seconds: LINK_CODE_TTL_MS / 1_000,
    });
  });

  /**
   * First-run mobile onboarding for an existing farm. The name is a lookup
   * only; the farm-bound Supervisor password is the authentication factor.
   * Duplicate/missing farm names intentionally produce the same generic
   * response and can use the Owner pairing-code fallback instead.
   */
  app.post("/api/field-devices/join-existing-farm", async (req, reply) => {
    const body = (req.body ?? {}) as JoinExistingFarmBody;
    const farmName = suppliedFarmName(body.farm_name);
    const normalized = normalizeSupervisorUsername(body.username);
    const password = typeof body.password === "string" ? body.password : "";
    const deviceId = typeof body.device_id === "string" ? body.device_id : "";
    if (!farmName || !normalized.ok || !password || !isUuid(deviceId)) {
      await verifySupervisorPasswordOrDummy(password);
      return reply.status(401).send({ error: INVALID_JOIN_MESSAGE });
    }

    const db = await getDb();
    const farms = await db.query(
      `SELECT farm_id, name
         FROM farms
        WHERE LOWER(name)=LOWER($1)
        ORDER BY farm_id ASC
        LIMIT 2`,
      [farmName],
    );
    const matches = farms.rows as FarmRow[];
    if (matches.length !== 1) {
      await verifySupervisorPasswordOrDummy(password);
      return reply.status(401).send({ error: INVALID_JOIN_MESSAGE });
    }
    const farm = matches[0]!;

    const lockedUntil = await supervisorLoginLock(db, farm.farm_id, normalized.value);
    if (lockedUntil) {
      return reply
        .header("Retry-After", String(retryAfterSeconds(lockedUntil)))
        .status(429)
        .send({ error: "too many sign-in attempts; try again later" });
    }
    const userResult = await db.query(
      `SELECT user_id, farm_id, username, password_hash
         FROM users
        WHERE farm_id=$1 AND username=$2 AND role='supervisor' AND disabled_at IS NULL
        LIMIT 1`,
      [farm.farm_id, normalized.value],
    );
    const supervisor = (userResult.rows as SupervisorRow[])[0];
    const passwordMatches = await verifySupervisorPasswordOrDummy(
      password,
      supervisor?.password_hash,
    );
    if (!supervisor || !passwordMatches) {
      const lock = await noteSupervisorLoginFailure(db, farm.farm_id, normalized.value);
      if (lock) {
        return reply
          .header("Retry-After", String(retryAfterSeconds(lock)))
          .status(429)
          .send({ error: "too many sign-in attempts; try again later" });
      }
      return reply.status(401).send({ error: INVALID_JOIN_MESSAGE });
    }

    try {
      const supervisorToken = createSupervisorSessionToken();
      const supervisorExpiresAt = new Date(Date.now() + SUPERVISOR_SESSION_MS).toISOString();
      const linked = await withTransaction(async (tx) => {
        const existingResult = await tx.query(
          "SELECT farm_id, access_token_hash, revoked FROM devices WHERE device_id=$1 FOR UPDATE",
          [deviceId],
        );
        const existing = (existingResult.rows as ExistingDeviceRow[])[0];
        // A device that already has a row must prove possession of its old
        // opaque credential too. This prevents a valid Supervisor account from
        // moving an arbitrary guessed device ID away from another farm.
        if (existing && (existing.revoked || !tokenMatchesStoredDigest(body.current_device_token, existing.access_token_hash))) {
          throw new Error(INVALID_JOIN_MESSAGE);
        }
        await clearSupervisorLoginFailures(tx, farm.farm_id, normalized.value);
        const deviceToken = await linkDeviceToFarm({
          tx,
          farm,
          deviceId,
          existingDevice: existing,
          audit: {
            actor: "field-device-join",
            targetAction: "field_device.joined",
            targetDetail: { method: "supervisor_credentials" },
            sourceReason: "supervisor_authenticated_join",
          },
        });
        // The credentials have just been verified, so the first-run join is
        // also a normal short-lived Supervisor sign-in. The PWA stores this
        // only in sessionStorage and never bridges it to Android native code.
        await tx.query(
          `INSERT INTO sessions (token, user_id, farm_id, role, expires_at)
           VALUES ($1,$2,$3,'supervisor',$4)`,
          [
            digestSupervisorSessionToken(supervisorToken),
            supervisor.user_id,
            farm.farm_id,
            supervisorExpiresAt,
          ],
        );
        await auditFieldDeviceLink({
          farmId: farm.farm_id,
          actor: supervisor.username,
          action: "supervisor.login",
          target: null,
          detail: { via: "existing_farm_join" },
          dbClient: tx,
        });
        return { deviceToken };
      });
      return reply.status(200).send({
        ok: true,
        farm_id: farm.farm_id,
        name: farm.name,
        device_token: linked.deviceToken,
        username: supervisor.username,
        supervisor_token: supervisorToken,
        supervisor_expires_at: supervisorExpiresAt,
      });
    } catch (error) {
      if ((error as Error).message === INVALID_JOIN_MESSAGE) {
        return reply.status(401).send({ error: INVALID_JOIN_MESSAGE });
      }
      throw error;
    }
  });

  /**
   * Consumes an Owner-approved pairing code. It deliberately accepts neither a
   * farm ID nor an Admin bearer credential from the field device. The code is
   * the short-lived, single-use authority; the response remains generic for an
   * invalid, expired, or previously consumed value.
   */
  app.post("/api/field-devices/link", async (req, reply) => {
    const body = (req.body ?? {}) as ConsumeLinkCodeBody;
    const code = suppliedLinkCode(body.code);
    const deviceId = typeof body.device_id === "string" ? body.device_id : "";
    if (!code || !isUuid(deviceId)) {
      return reply.status(400).send({ error: INVALID_LINK_CODE_MESSAGE });
    }

    try {
      const linked = await withTransaction(async (tx) => {
        // The conditional UPDATE is the single-use gate. In a real PostgreSQL
        // transaction it also serializes concurrent attempts; a failed update
        // cannot reveal whether the code was mistyped, expired, or consumed.
        const consumed = await tx.query(
          `UPDATE field_device_link_codes
              SET consumed_at=NOW(), consumed_device_id=$2
            WHERE code_hash=$1
              AND consumed_at IS NULL
              AND expires_at > NOW()
          RETURNING code_id, farm_id`,
          [digestLinkCode(code), deviceId],
        );
        const codeRow = (consumed.rows as ConsumedCodeRow[])[0];
        if (!codeRow) throw new Error(INVALID_LINK_CODE_MESSAGE);

        const farmResult = await tx.query(
          "SELECT farm_id, name FROM farms WHERE farm_id=$1 LIMIT 1",
          [codeRow.farm_id],
        );
        const farm = (farmResult.rows as FarmRow[])[0];
        // This should be impossible due to the foreign key, but it keeps the
        // response safe if an operator has damaged data manually.
        if (!farm) throw new Error("field device linking could not be completed");

        const deviceToken = await linkDeviceToFarm({
          tx,
          farm,
          deviceId,
          audit: {
            actor: "field-device-link",
            targetAction: "field_device.linked",
            targetDetail: { link_code_id: codeRow.code_id },
            sourceReason: "owner_approved_relink",
          },
        });
        return { farm, deviceToken };
      });

      return reply.status(200).send({
        ok: true,
        farm_id: linked.farm.farm_id,
        name: linked.farm.name,
        device_token: linked.deviceToken,
      });
    } catch (error) {
      if ((error as Error).message === INVALID_LINK_CODE_MESSAGE) {
        return reply.status(400).send({ error: INVALID_LINK_CODE_MESSAGE });
      }
      throw error;
    }
  });
}
