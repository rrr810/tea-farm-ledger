import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { normalizeNationalIdNumber } from "@tea-ledger/core";
import { getDb, type DbClient } from "./db.js";

export const MAX_ID_PHOTO_BYTES = 1_250_000;
export const ID_PHOTO_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type IdPhotoContentType = (typeof ID_PHOTO_CONTENT_TYPES)[number];

export type IdentityPhotoInput = {
  contentType: string;
  base64: string;
};

export type DecodedIdentityPhoto = {
  contentType: IdPhotoContentType;
  bytes: Buffer;
  sha256: string;
};

export type IdentityProfileSummary = {
  worker_id: string;
  farm_id: string;
  full_name: string;
  phone_e164: string | null;
  status: string;
  verified: boolean;
  created_at: string | Date;
  has_identity: boolean;
  has_id_photo: boolean;
  identity_recorded_at: string | Date | null;
};

export type IdentityProfile = IdentityProfileSummary & {
  national_id_number: string | null;
  identity_consent_at: string | Date | null;
  identity_consent_author: string | null;
  id_photo: {
    content_type: IdPhotoContentType;
    byte_size: number;
    captured_at: string | Date;
  } | null;
};

type EncryptedValue = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
};

type IdentityRecordRow = {
  identity_id: string;
  national_id_lookup: string;
  national_id_ciphertext: unknown;
  national_id_iv: unknown;
  national_id_auth_tag: unknown;
  consent_at: string | Date;
  consent_author: string;
  recorded_at: string | Date;
};

type DocumentRow = {
  content_type: IdPhotoContentType;
  encrypted_bytes: unknown;
  iv: unknown;
  auth_tag: unknown;
  sha256: string;
  byte_size: number | string;
  captured_at: string | Date;
};

function identityKey(): Buffer {
  // A dedicated key may be supplied later. Existing Production already has a
  // SESSION_SECRET, so this feature fails closed rather than persisting an
  // identity record unencrypted when neither secret is configured.
  const secret =
    process.env.WORKER_IDENTITY_ENCRYPTION_KEY ?? process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "private worker identity storage is unavailable: configure SESSION_SECRET or WORKER_IDENTITY_ENCRYPTION_KEY",
    );
  }
  return createHash("sha256")
    .update("tea-ledger:worker-identity:v1\0")
    .update(secret)
    .digest();
}

function encrypt(value: Buffer): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", identityKey(), iv);
  return {
    ciphertext: Buffer.concat([cipher.update(value), cipher.final()]),
    iv,
    authTag: cipher.getAuthTag(),
  };
}

function decrypt(value: EncryptedValue): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", identityKey(), value.iv);
  decipher.setAuthTag(value.authTag);
  return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]);
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
    return Buffer.from(value, "base64");
  }
  throw new Error("private worker identity data is unreadable");
}

function identityLookup(normalizedId: string): string {
  return createHmac("sha256", identityKey())
    .update("national-id\0")
    .update(normalizedId)
    .digest("hex");
}

function isBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function matchesImageMagic(bytes: Buffer, contentType: IdPhotoContentType): boolean {
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    );
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

export function decodeIdentityPhoto(input: IdentityPhotoInput): DecodedIdentityPhoto {
  if (!ID_PHOTO_CONTENT_TYPES.includes(input.contentType as IdPhotoContentType)) {
    throw new Error("ID image must be JPEG, PNG, or WebP");
  }
  if (!isBase64(input.base64)) {
    throw new Error("ID image data is invalid");
  }
  // Check the encoded length before decoding to avoid a large request becoming a
  // large allocation in the serverless function.
  const estimatedBytes = Math.floor((input.base64.length * 3) / 4) - (input.base64.endsWith("==") ? 2 : input.base64.endsWith("=") ? 1 : 0);
  if (estimatedBytes <= 0 || estimatedBytes > MAX_ID_PHOTO_BYTES) {
    throw new Error("ID image must be no larger than 1.25 MB");
  }
  const bytes = Buffer.from(input.base64, "base64");
  const contentType = input.contentType as IdPhotoContentType;
  if (bytes.length !== estimatedBytes || !matchesImageMagic(bytes, contentType)) {
    throw new Error("ID image content does not match its declared type");
  }
  return {
    contentType,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function assertWorkerIdentityAvailable(opts: {
  farmId: string;
  nationalIdNumber: string;
  dbClient?: DbClient;
}): Promise<{ normalizedId: string; lookup: string }> {
  const db = opts.dbClient ?? (await getDb());
  const normalized = normalizeNationalIdNumber(opts.nationalIdNumber);
  if (!normalized.ok) throw new Error(normalized.reason);
  const lookup = identityLookup(normalized.value);
  const duplicate = await db.query(
    `SELECT worker_id FROM worker_identity_records
      WHERE farm_id=$1 AND national_id_lookup=$2 AND superseded_at IS NULL
      LIMIT 1`,
    [opts.farmId, lookup],
  );
  if ((duplicate.rows as unknown[]).length > 0) {
    throw new Error("an active worker profile already uses this ID number");
  }
  return { normalizedId: normalized.value, lookup };
}

export async function recordWorkerIdentity(opts: {
  farmId: string;
  workerId: string;
  nationalIdNumber: string;
  consentAuthor: string;
  photo?: DecodedIdentityPhoto;
  dbClient?: DbClient;
}): Promise<{ identityId: string; hasPhoto: boolean }> {
  const db = opts.dbClient ?? (await getDb());
  const availability = await assertWorkerIdentityAvailable({
    farmId: opts.farmId,
    nationalIdNumber: opts.nationalIdNumber,
    dbClient: db,
  });
  const consentAuthor = opts.consentAuthor.trim();
  if (!consentAuthor) throw new Error("identity consent author is required");

  const worker = await db.query(
    "SELECT worker_id FROM workers WHERE worker_id=$1 AND farm_id=$2",
    [opts.workerId, opts.farmId],
  );
  if ((worker.rows as unknown[]).length === 0) {
    throw new Error("worker is not in this farm");
  }

  const current = await db.query(
    `SELECT identity_id FROM worker_identity_records
      WHERE worker_id=$1 AND farm_id=$2 AND superseded_at IS NULL
      LIMIT 1`,
    [opts.workerId, opts.farmId],
  );
  if ((current.rows as unknown[]).length > 0) {
    throw new Error("worker already has a private identity record");
  }

  const encryptedId = encrypt(Buffer.from(availability.normalizedId, "utf8"));
  const identityId = randomUUID();
  await db.query(
    `INSERT INTO worker_identity_records
      (identity_id, farm_id, worker_id, national_id_lookup, national_id_ciphertext, national_id_iv, national_id_auth_tag, consent_at, consent_author)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8)`,
    [
      identityId,
      opts.farmId,
      opts.workerId,
      availability.lookup,
      encryptedId.ciphertext,
      encryptedId.iv,
      encryptedId.authTag,
      consentAuthor,
    ],
  );

  if (opts.photo) {
    const encryptedImage = encrypt(opts.photo.bytes);
    await db.query(
      `INSERT INTO worker_identity_documents
        (document_id, identity_id, farm_id, worker_id, document_type, content_type, encrypted_bytes, iv, auth_tag, sha256, byte_size, captured_by)
       VALUES ($1,$2,$3,$4,'national_id_photo',$5,$6,$7,$8,$9,$10,$11)`,
      [
        randomUUID(),
        identityId,
        opts.farmId,
        opts.workerId,
        opts.photo.contentType,
        encryptedImage.ciphertext,
        encryptedImage.iv,
        encryptedImage.authTag,
        opts.photo.sha256,
        opts.photo.bytes.length,
        consentAuthor,
      ],
    );
  }

  return { identityId, hasPhoto: Boolean(opts.photo) };
}

export async function listWorkerIdentitySummaries(
  farmId: string,
  dbClient?: DbClient,
): Promise<IdentityProfileSummary[]> {
  const db = dbClient ?? (await getDb());
  const res = await db.query(
    `SELECT
       w.worker_id, w.farm_id, w.full_name, w.phone_e164, w.status, w.verified, w.created_at,
       (ir.identity_id IS NOT NULL) AS has_identity,
       (doc.document_id IS NOT NULL) AS has_id_photo,
       ir.recorded_at AS identity_recorded_at
     FROM workers w
     LEFT JOIN worker_identity_records ir
       ON ir.worker_id=w.worker_id AND ir.farm_id=w.farm_id AND ir.superseded_at IS NULL
     LEFT JOIN worker_identity_documents doc
       ON doc.identity_id=ir.identity_id AND doc.document_type='national_id_photo' AND doc.superseded_at IS NULL
     WHERE w.farm_id=$1
     ORDER BY w.created_at ASC`,
    [farmId],
  );
  return res.rows as IdentityProfileSummary[];
}

export async function getWorkerIdentityProfile(opts: {
  farmId: string;
  workerId: string;
  dbClient?: DbClient;
}): Promise<IdentityProfile | null> {
  const db = opts.dbClient ?? (await getDb());
  const workerResult = await db.query(
    `SELECT worker_id, farm_id, full_name, phone_e164, status, verified, created_at
       FROM workers WHERE worker_id=$1 AND farm_id=$2`,
    [opts.workerId, opts.farmId],
  );
  const worker = (workerResult.rows as Array<Omit<IdentityProfileSummary, "has_identity" | "has_id_photo" | "identity_recorded_at">>)[0];
  if (!worker) return null;

  const identityResult = await db.query(
    `SELECT identity_id, national_id_lookup, national_id_ciphertext, national_id_iv, national_id_auth_tag,
            consent_at, consent_author, recorded_at
       FROM worker_identity_records
      WHERE worker_id=$1 AND farm_id=$2 AND superseded_at IS NULL
      LIMIT 1`,
    [opts.workerId, opts.farmId],
  );
  const identity = (identityResult.rows as IdentityRecordRow[])[0];
  if (!identity) {
    return {
      ...worker,
      has_identity: false,
      has_id_photo: false,
      identity_recorded_at: null,
      national_id_number: null,
      identity_consent_at: null,
      identity_consent_author: null,
      id_photo: null,
    };
  }

  const documentResult = await db.query(
    `SELECT content_type, encrypted_bytes, iv, auth_tag, sha256, byte_size, captured_at
       FROM worker_identity_documents
      WHERE identity_id=$1 AND document_type='national_id_photo' AND superseded_at IS NULL
      LIMIT 1`,
    [identity.identity_id],
  );
  const document = (documentResult.rows as DocumentRow[])[0];
  const nationalId = decrypt({
    ciphertext: asBuffer(identity.national_id_ciphertext),
    iv: asBuffer(identity.national_id_iv),
    authTag: asBuffer(identity.national_id_auth_tag),
  }).toString("utf8");

  return {
    ...worker,
    has_identity: true,
    has_id_photo: Boolean(document),
    identity_recorded_at: identity.recorded_at,
    national_id_number: nationalId,
    identity_consent_at: identity.consent_at,
    identity_consent_author: identity.consent_author,
    id_photo: document
      ? {
          content_type: document.content_type,
          byte_size: Number(document.byte_size),
          captured_at: document.captured_at,
        }
      : null,
  };
}

export async function getWorkerIdentityPhoto(opts: {
  farmId: string;
  workerId: string;
  dbClient?: DbClient;
}): Promise<{ contentType: IdPhotoContentType; bytes: Buffer } | null> {
  const db = opts.dbClient ?? (await getDb());
  const result = await db.query(
    `SELECT doc.content_type, doc.encrypted_bytes, doc.iv, doc.auth_tag
       FROM worker_identity_documents doc
       JOIN worker_identity_records ir ON ir.identity_id=doc.identity_id
      WHERE doc.farm_id=$1 AND doc.worker_id=$2
        AND doc.document_type='national_id_photo' AND doc.superseded_at IS NULL
        AND ir.superseded_at IS NULL
      LIMIT 1`,
    [opts.farmId, opts.workerId],
  );
  const row = (result.rows as Array<Pick<DocumentRow, "content_type" | "encrypted_bytes" | "iv" | "auth_tag">>)[0];
  if (!row) return null;
  return {
    contentType: row.content_type,
    bytes: decrypt({
      ciphertext: asBuffer(row.encrypted_bytes),
      iv: asBuffer(row.iv),
      authTag: asBuffer(row.auth_tag),
    }),
  };
}
