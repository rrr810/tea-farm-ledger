import type { FastifyInstance } from "fastify";
import { getDb } from "@tea-ledger/database";
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
  /**
   * A field device can no longer create a farm. It must join a farm provisioned
   * by the Master Admin with the Supervisor credentials supplied to it.
   */
  app.post("/api/farms", async (_req, reply) => {
    return reply.status(403).send({
      error: "new farms can be created only from the Master Admin console",
    });
  });

  // A retained farm Owner sees only its bound farm; the Master deliberately
  // receives the cross-farm list used by the central Farms console.
  app.get("/api/farms", async (req, reply) => {
    const admin = await requireAdminSession(req, reply);
    if (!admin) return;
    const db = await getDb();
    const res = admin.kind === "platform"
      ? await db.query("SELECT farm_id, name FROM farms ORDER BY LOWER(name), farm_id")
      : await db.query("SELECT farm_id, name FROM farms WHERE farm_id=$1", [admin.farmId]);
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
      // A Master Admin is not a farm user, so it may authorize this action
      // without being recorded as a Supervisor/Owner foreign key on the device.
      supervisorUserId = admin.userId ?? undefined;
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
