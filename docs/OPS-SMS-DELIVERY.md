# Mobile Sasa delivery status operations

## What a status means

- **Queued** — Mobile Sasa accepted Tea Ledger's send request. It is **not** proof that the handset received the SMS.
- **Sent** — Mobile Sasa reports that the carrier accepted the SMS. It is still an interim state.
- **Delivered** — Mobile Sasa reports handset delivery.
- **Failed** — Mobile Sasa reports a terminal failure (for example rejected, expired, or unreachable).

Tea Ledger never turns an unknown result into `failed`, and a late interim callback cannot downgrade a stored `delivered` or `failed` result.

## Owner/Admin refresh

The SMS tab's **Refresh delivery status** control uses Mobile Sasa's read-only `POST /v1/dlr` lookup for already accepted live-daily rows only. It does **not** call the send endpoint, retry a message, create a new row, change a recipient, or consume an SMS unit.

Rows with no usable provider report remain in their prior state, normally `queued`.

## Optional real-time callback

The deployed route is:

```text
https://tea-farm-ledger.vercel.app/api/sms/mobilesasa-delivery-report
```

It intentionally returns `404` until `MOBILESASA_WEBHOOK_SECRET` has been configured in the deployment environment. When it is configured, the route requires an exact constant-time match for Mobile Sasa's `X-MobileSasa-Secret` header before processing a report. It reconciles by either:

1. Mobile Sasa's `reference` / send `messageId`, or
2. Tea Ledger's supplied v2 `trackingId`.

The callback is idempotent and has no send or retry code path. Configure it in the Mobile Sasa portal only when the matching webhook secret is ready in the production environment. Do not paste the secret into the repository, ticket, CSV, report, or SMS.

## Safety boundaries

- Do not resend a `queued`, `sent`, or `failed` row from this tool.
- Do not infer delivery from a person's name, network, or a provider send acknowledgement.
- A human statement that an SMS arrived may be operationally useful, but it does not replace the provider's delivery-report audit status.
