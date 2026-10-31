import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDb,
  runMigrations,
  createWorker,
  listWorkers,
  decodeIdentityPhoto,
  recordWorkerIdentity,
  listWorkerIdentitySummaries,
  getWorkerIdentityProfile,
  getWorkerIdentityPhoto,
} from "@tea-ledger/database";
import type { DbClient } from "@tea-ledger/database";

const farmId = "00000000-0000-4000-a000-000000000081";
let db: DbClient;

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-worker-identity-secret-that-is-long-enough";
  db = await createTestDb();
  await runMigrations(db);
  await db.query("INSERT INTO farms (farm_id, name) VALUES ($1,$2)", [
    farmId,
    "Private Identity Test Farm",
  ]);
});

afterAll(async () => {
  if (db?.end) await db.end();
});

describe("private worker identity records", () => {
  it("encrypts an ID/photo and exposes it only through the private profile helpers", async () => {
    const worker = await createWorker({
      farmId,
      fullName: "Identity Test Worker",
      phone: "0712345681",
      consentAuthor: "supervisor",
      dbClient: db,
    });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const photo = decodeIdentityPhoto({
      contentType: "image/jpeg",
      base64: jpeg.toString("base64"),
    });
    const recorded = await recordWorkerIdentity({
      farmId,
      workerId: worker.worker_id,
      nationalIdNumber: "12 345 678",
      consentAuthor: "supervisor",
      photo,
      dbClient: db,
    });
    expect(recorded.hasPhoto).toBe(true);

    // Normal worker projections remain safe for the supervisor/PWA.
    const publicWorkers = await listWorkers(farmId, db);
    expect(publicWorkers).toHaveLength(1);
    expect(Object.keys(publicWorkers[0])).not.toContain("national_id_number");
    expect(JSON.stringify(publicWorkers[0])).not.toContain("12345678");

    const summary = await listWorkerIdentitySummaries(farmId, db);
    expect(summary[0]).toEqual(
      expect.objectContaining({
        worker_id: worker.worker_id,
        has_identity: true,
        has_id_photo: true,
      }),
    );
    expect(JSON.stringify(summary[0])).not.toContain("12345678");

    const profile = await getWorkerIdentityProfile({
      farmId,
      workerId: worker.worker_id,
      dbClient: db,
    });
    expect(profile).toEqual(
      expect.objectContaining({
        national_id_number: "12345678",
        has_id_photo: true,
      }),
    );

    const fetchedPhoto = await getWorkerIdentityPhoto({
      farmId,
      workerId: worker.worker_id,
      dbClient: db,
    });
    expect(fetchedPhoto?.contentType).toBe("image/jpeg");
    expect(fetchedPhoto?.bytes.equals(jpeg)).toBe(true);

    const stored = await db.query(
      "SELECT national_id_ciphertext FROM worker_identity_records WHERE identity_id=$1",
      [recorded.identityId],
    );
    expect(String((stored.rows as Array<{ national_id_ciphertext: unknown }>)[0].national_id_ciphertext)).not.toContain("12345678");
  });

  it("rejects a duplicate current ID number rather than silently assigning it", async () => {
    const worker = await createWorker({
      farmId,
      fullName: "Duplicate Identity Worker",
      phone: "0712345682",
      consentAuthor: "supervisor",
      dbClient: db,
    });
    await expect(
      recordWorkerIdentity({
        farmId,
        workerId: worker.worker_id,
        nationalIdNumber: "12345678",
        consentAuthor: "supervisor",
        dbClient: db,
      }),
    ).rejects.toThrow("already uses this ID number");
  });

  it("rejects a declared JPEG that does not contain JPEG bytes", () => {
    expect(() =>
      decodeIdentityPhoto({
        contentType: "image/jpeg",
        base64: Buffer.from("not a photo").toString("base64"),
      }),
    ).toThrow("does not match");
  });
});
