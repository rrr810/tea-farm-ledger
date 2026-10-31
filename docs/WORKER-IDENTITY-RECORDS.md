# Private Worker Identity Records

**Approved by the owner on 2026-10-31.** This narrowly supersedes the earlier
pilot rule that workers were limited to name and mobile number.

## Scope

A new worker is recorded with:

- full name;
- Kenyan-format mobile number;
- national ID number; and
- an optional ID-card image (JPEG, PNG, or WebP).

The supervisor may collect the record while online. Existing workers are
completed gradually. Missing identity information never blocks kg capture,
daily completion, or payroll finalisation. To preserve the existing offline
worker-registration flow, an offline supervisor may explicitly save a **basic**
name-and-phone worker; the PWA discards any typed identity data and requires a
later online identity-profile completion.

## Consent and access

The Supervisor PWA records two separate confirmations:

1. SMS-receipt consent; and
2. consent to private storage of the ID number and optional ID image.

The database timestamps the identity consent and records the collection author.
The supervisor can see only the normal worker list after submission. A full
identity profile, including the unmasked number and image, is available only to
a signed-in **Admin** session bound to the same farm. Each identity profile or
image view writes an audit-log entry.

## Storage controls

- National ID numbers and optional images are encrypted with AES-256-GCM before
  they are written to PostgreSQL.
- A keyed lookup value prevents two current workers at the same farm from being
  registered with the same ID number without storing the number in plaintext.
- The key is derived from `WORKER_IDENTITY_ENCRYPTION_KEY` when configured, or
  the existing `SESSION_SECRET` otherwise. The feature fails closed if neither
  secret exists.
- Photos are compressed in transient browser memory and submitted only while
  online. They are never written to the PWA IndexedDB database, sync outbox,
  event history, SMS messages, CSV exports, public worker responses, or audit
  details.
- The server allows only JPEG, PNG, and WebP image bytes, checks their file
  signature, and limits the decoded image to 1.25 MB.
- Corrections are designed to retain history through superseded records; no
  identity document is silently deleted.

## Explicit non-goals

This feature does not claim formal regulatory certification, perform automated
identity verification, send an identity image outside the Tea Ledger database,
or establish a multi-farm tenancy model. It makes no Mobile Sasa send/retry,
provider, payment, or paid-service change.
