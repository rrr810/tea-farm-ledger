import type { FastifyInstance } from "fastify";
import {
  getDb,
  withTransaction,
  type DbClient,
  createWorker,
  listWorkers,
  startEmployment,
  endEmployment,
  listEmployment,
  decodeIdentityPhoto,
  assertWorkerIdentityAvailable,
  recordWorkerIdentity,
  listWorkerIdentitySummaries,
  getWorkerIdentityProfile,
  getWorkerIdentityPhoto,
} from "@tea-ledger/database";
import { normalizeNationalIdNumber, validateWorkerName } from "@tea-ledger/core";
import { requireAdminForFarm } from "../admin-auth.js";
import { requireSupervisorForFarm } from "../supervisor-auth.js";

type IdentityPhotoBody = { content_type?: string; base64?: string };
type CreateWorkerBody = {
  full_name?: string;
  phone?: string;
  consent?: boolean;
  national_id_number?: string;
  identity_consent?: boolean;
  id_photo?: IdentityPhotoBody;
};

function todayEAT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
}

function createErrorStatus(message: string): number {
  return message.includes("already") || message.includes("belongs to active")
    ? 409
    : 400;
}

async function auditIdentityAccess(opts: {
  farmId: string;
  actor: string;
  action: string;
  workerId: string;
  detail?: Record<string, unknown>;
  dbClient?: DbClient;
}) {
  const db = opts.dbClient ?? (await getDb());
  // Detail deliberately records only the fact of the action, never an ID
  // number, photo bytes, MIME payload, or phone number.
  await db.query(
    `INSERT INTO audit_log (farm_id, actor, action, target, detail)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [opts.farmId, opts.actor, opts.action, opts.workerId, JSON.stringify(opts.detail ?? {})],
  );
}

export async function workersRoutes(app: FastifyInstance) {
  // Safe supervisor/PWA view. Identity details are held in a separate table
  // and are never selected by this route.
  app.get("/api/farms/:farmId/workers", async (req) => {
    const { farmId } = req.params as { farmId: string };
    const workers = await listWorkers(farmId);
    return { workers };
  });

  // New worker intake is intentionally online-only in the PWA: a national ID
  // number/photo must never be queued in IndexedDB or an event outbox. It is
  // encrypted by the server before entering the database.
  app.post("/api/farms/:farmId/workers", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    // Basic-only registrations continue through the existing offline event-sync
    // route. This direct online identity-intake route always requires a
    // short-lived, farm-bound Supervisor session before validation or storage.
    const supervisor = await requireSupervisorForFarm(req, reply, farmId);
    if (!supervisor) return;
    const body = (req.body ?? {}) as CreateWorkerBody;
    const fullName = body.full_name?.trim() ?? "";
    const nameValidation = validateWorkerName(fullName);
    if (!nameValidation.valid) {
      return reply.status(400).send({ error: nameValidation.reason });
    }
    if (!body.phone) return reply.status(400).send({ error: "phone required" });
    if (!body.consent) {
      return reply.status(400).send({
        error: "SMS consent required — record the worker's agreement before adding them",
      });
    }
    if (!body.identity_consent) {
      return reply.status(400).send({
        error: "identity-information consent required before adding a worker",
      });
    }
    const nationalId = normalizeNationalIdNumber(body.national_id_number ?? "");
    if (!nationalId.ok) return reply.status(400).send({ error: nationalId.reason });

    let photo;
    try {
      photo = body.id_photo
        ? decodeIdentityPhoto({
            contentType: body.id_photo.content_type ?? "",
            base64: body.id_photo.base64 ?? "",
          })
        : undefined;
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }

    try {
      // Validate duplicate-ID conflicts before creating the worker projection,
      // so a normal input conflict never leaves behind a partial profile.
      await assertWorkerIdentityAvailable({
        farmId,
        nationalIdNumber: nationalId.value,
      });
    } catch (error) {
      const message = (error as Error).message;
      return reply.status(createErrorStatus(message)).send({ error: message });
    }

    // Consent authorship comes from the authenticated session, never a client
    // supplied field that could impersonate the field supervisor.
    const consentAuthor = supervisor.username;

    try {
      const result = await withTransaction(async (db) => {
        const created = await createWorker({
          farmId,
          fullName,
          phone: body.phone!,
          consentAuthor,
          dbClient: db,
        });
        await startEmployment({
          workerId: created.worker_id,
          farmId,
          startDate: todayEAT(),
          dbClient: db,
        });
        const identity = await recordWorkerIdentity({
          farmId,
          workerId: created.worker_id,
          nationalIdNumber: nationalId.value,
          consentAuthor,
          photo,
          dbClient: db,
        });
        await auditIdentityAccess({
          farmId,
          actor: consentAuthor,
          action: "worker.identity.recorded",
          workerId: created.worker_id,
          detail: {
            id_number_recorded: true,
            id_photo_recorded: identity.hasPhoto,
          },
          dbClient: db,
        });
        return { created, identity };
      });
      return {
        worker_id: result.created.worker_id,
        phone_e164: result.created.phone_e164,
        identity_recorded: true,
        id_photo_recorded: result.identity.hasPhoto,
      };
    } catch (error) {
      const message = (error as Error).message;
      return reply.status(createErrorStatus(message)).send({ error: message });
    }
  });

  // Existing workers are intentionally completed gradually. This adds only the
  // private identity record; it never alters kg/payroll history or the public
  // worker projection.
  app.post("/api/farms/:farmId/workers/:workerId/identity", async (req, reply) => {
    const { farmId, workerId } = req.params as { farmId: string; workerId: string };
    const supervisor = await requireSupervisorForFarm(req, reply, farmId);
    if (!supervisor) return;
    const body = (req.body ?? {}) as {
      national_id_number?: string;
      identity_consent?: boolean;
      id_photo?: IdentityPhotoBody;
    };
    if (!body.identity_consent) {
      return reply.status(400).send({ error: "identity-information consent required" });
    }
    const nationalId = normalizeNationalIdNumber(body.national_id_number ?? "");
    if (!nationalId.ok) return reply.status(400).send({ error: nationalId.reason });

    let photo;
    try {
      photo = body.id_photo
        ? decodeIdentityPhoto({
            contentType: body.id_photo.content_type ?? "",
            base64: body.id_photo.base64 ?? "",
          })
        : undefined;
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }

    const consentAuthor = supervisor.username;
    try {
      const identity = await withTransaction(async (db) => {
        const saved = await recordWorkerIdentity({
          farmId,
          workerId,
          nationalIdNumber: nationalId.value,
          consentAuthor,
          photo,
          dbClient: db,
        });
        await auditIdentityAccess({
          farmId,
          actor: consentAuthor,
          action: "worker.identity.recorded",
          workerId,
          detail: { id_number_recorded: true, id_photo_recorded: saved.hasPhoto },
          dbClient: db,
        });
        return saved;
      });
      return { identity_recorded: true, id_photo_recorded: identity.hasPhoto };
    } catch (error) {
      const message = (error as Error).message;
      return reply.status(createErrorStatus(message)).send({ error: message });
    }
  });

  app.post("/api/workers/:workerId/hire", async (req, reply) => {
    const { workerId } = req.params as { workerId: string };
    const body = req.body as { farm_id?: string; start_date?: string };
    if (!body.farm_id || !body.start_date) return reply.status(400).send({ error: "farm_id and start_date required" });
    try {
      const res = await startEmployment({ workerId, farmId: body.farm_id, startDate: body.start_date });
      return res;
    } catch (e) { return reply.status(409).send({ error: String((e as Error).message) }); }
  });

  app.post("/api/workers/:workerId/fire", async (req, reply) => {
    const { workerId } = req.params as { workerId: string };
    const body = req.body as { end_date?: string; reason?: string };
    if (!body.end_date) return reply.status(400).send({ error: "end_date required (inclusive)" });
    try {
      const res = await endEmployment({ workerId, endDate: body.end_date, reason: body.reason });
      return res;
    } catch (e) { return reply.status(409).send({ error: String((e as Error).message) }); }
  });

  app.get("/api/workers/:workerId/employment", async (req) => {
    const { workerId } = req.params as { workerId: string };
    const periods = await listEmployment(workerId);
    return { periods };
  });

  // The three routes below are the only API surface that can reveal private
  // worker identity data. A valid, farm-bound Admin session is mandatory.
  app.get("/api/admin/farms/:farmId/workers", async (req, reply) => {
    const { farmId } = req.params as { farmId: string };
    const admin = await requireAdminForFarm(req, reply, farmId);
    if (!admin) return;
    const workers = await listWorkerIdentitySummaries(farmId);
    return { workers };
  });

  app.get("/api/admin/farms/:farmId/workers/:workerId", async (req, reply) => {
    const { farmId, workerId } = req.params as { farmId: string; workerId: string };
    const admin = await requireAdminForFarm(req, reply, farmId);
    if (!admin) return;
    const worker = await getWorkerIdentityProfile({ farmId, workerId });
    if (!worker) return reply.status(404).send({ error: "worker not found" });
    await auditIdentityAccess({
      farmId,
      actor: admin.username,
      action: "worker.identity.viewed",
      workerId,
    });
    return { worker };
  });

  app.get("/api/admin/farms/:farmId/workers/:workerId/id-photo", async (req, reply) => {
    const { farmId, workerId } = req.params as { farmId: string; workerId: string };
    const admin = await requireAdminForFarm(req, reply, farmId);
    if (!admin) return;
    const photo = await getWorkerIdentityPhoto({ farmId, workerId });
    if (!photo) return reply.status(404).send({ error: "ID photo not on file" });
    await auditIdentityAccess({
      farmId,
      actor: admin.username,
      action: "worker.identity_photo.viewed",
      workerId,
    });
    reply
      .header("Cache-Control", "private, no-store, max-age=0")
      .header("Pragma", "no-cache")
      .header("X-Content-Type-Options", "nosniff")
      .type(photo.contentType);
    return reply.send(photo.bytes);
  });
}
