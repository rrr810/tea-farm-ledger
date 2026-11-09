import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

let db: PGlite | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("owner farm-registration name migration", () => {
  it("reserves a canonical name without failing when legacy farms already have duplicate names", async () => {
    db = new PGlite();
    for (const migration of [
      "001_initial.sql",
      "002_private_worker_identity.sql",
      "002_sms_idempotency.sql",
      "003_admin_reports.sql",
      "004_supervisor_identity_access.sql",
      "005_device_access_tokens.sql",
      "006_field_device_link_codes.sql",
    ]) {
      await db.exec(await readFile(`packages/database/migrations/${migration}`, "utf8"));
    }

    await db.query(
      "INSERT INTO farms (farm_id, name) VALUES ($1,$2),($3,$4)",
      [
        "00000000-0000-4000-a000-000000009001",
        "Legacy Duplicate Farm",
        "00000000-0000-4000-a000-000000009002",
        " legacy duplicate farm ",
      ],
    );

    await db.exec(
      await readFile("packages/database/migrations/008_owner_farm_registration.sql", "utf8"),
    );

    const reserved = await db.query(
      "SELECT canonical_name, farm_id FROM farm_name_reservations ORDER BY canonical_name",
    );
    expect(reserved.rows).toHaveLength(1);
    expect(reserved.rows[0]).toEqual(
      expect.objectContaining({ canonical_name: "legacy duplicate farm" }),
    );
  });
});
