import type { FastifyInstance } from "fastify";
import { getDb, withTransaction } from "@tea-ledger/database";
import { validateFarmName } from "@tea-ledger/core";
import { randomUUID } from "node:crypto";
import { requireAdminForFarm, requireAdminSession } from "../admin-auth.js";
import { currentSupervisorSession } from "../supervisor-auth.js";
import { isUuid, issueFarmDeviceAccess, requireFarmDevice } from "../device-auth.js";

type FarmRow = { farm_id: string; name: string };

function bearerToken(req: { headers: Record<string, unknown> }): string {
  return String(req.headers.authorization ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

/**
 * Farm names are canonical and field-device bound. A farm ID is never accepted
 * as proof that a browser may read or sync that farm's records.
 */
export async function farmsRoutes(app: FastifyInstance) {
  app.post("/api/farms", async (req, reply) => {
    const body = req.body as { name?: unknown; device_id?: unknown };
    const rawName = typeof body?.name === "string" ? body.name : "";
    const validation = validateFarmName(rawName);
    if (!validation.valid) return reply.status(400).send({ error: validation.reason });
    const deviceId = body?.device_id;
    if (!isUuid(deviceId)) {
      return reply.status(400).send({ error: "a valid field device identifier is required" });
    }

    const name = rawName.trim();
    const farmId = randomUUID();
    try {
      const enrolled = await withTransaction(async (db) => {
        await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [farmId, name]);
        await db.query(
          "INSERT INTO rates (farm_id, effective_from, rate_cents_per_kg) VALUES ($1,'2020-01-01',900) ON CONFLICT DO NOTHING",
          [farmId],
        );
        return issueFarmDeviceAccess({
          farmId,
          deviceId,
          dbClient: db,
        });
      });
      return { farm_id: farmId, name, device_token: enrolled.deviceToken };
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : "farm registration could not be completed",
      });
    }
  });

  // An Owner/Admin sees only the farm bound to the current admin session.
  app.get("/api/farms", async (req, reply) => {
    const admin = await requireAdminSession(req, reply);
    if (!admin) return;
    const db = await getDb();
    const res = await db.query("SELECT farm_id, name FROM farms WHERE farm_id=$1", [admin.farmId]);
    return { farms: res.rows as FarmRow[] };
  });

  // The PWA refreshes the display label only after its field-device credential
  // is accepted. This remains a narrow response: no people, settings, or events.
  app.get("/api/farms/:farmId", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const device = await requireFarmDevice(req, reply, farmId);
    if (!device) return;
    const db = await getDb();
    const result = await db.query(
      "SELECT farm_id, name FROM farms WHERE farm_id=$1 LIMIT 1",
      [farmId],
    );
    const farm = (result.rows as FarmRow[])[0];
    if (!farm) return reply.status(404).send({ error: "farm not found" });
    return farm;
  });

  /**
   * Existing registered field phones did not receive a device token in the
   * original pilot. A farm-bound Supervisor or Owner/Admin can enroll that
   * exact browser once; an unknown browser cannot use a visible Farm ID alone.
   */
  app.post("/api/farms/:farmId/devices/enroll", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const body = (req.body ?? {}) as { device_id?: unknown };
    if (!isUuid(farmId) || !isUuid(body.device_id)) {
      return reply.status(400).send({ error: "valid farm and device identifiers are required" });
    }

    const token = bearerToken(req);
    const supervisor = token ? await currentSupervisorSession(token) : null;
    let supervisorUserId: string | undefined;
    if (supervisor) {
      if (supervisor.farmId !== farmId) {
        return reply.status(403).send({ error: "supervisor access is not authorized for this farm" });
      }
      supervisorUserId = supervisor.userId;
    } else {
      const admin = await requireAdminForFarm(req, reply, farmId);
      if (!admin) return;
      supervisorUserId = admin.userId;
    }

    try {
      const enrolled = await issueFarmDeviceAccess({
        farmId,
        deviceId: body.device_id,
        supervisorUserId,
      });
      return { farm_id: farmId, device_id: body.device_id, device_token: enrolled.deviceToken };
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : "device enrollment could not be completed",
      });
    }
  });
}
