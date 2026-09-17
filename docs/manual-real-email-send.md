# Manual Real-Email Test — Controlled Single-Email Delivery (Step 19)

This document describes the ONLY sanctioned way to send a real email from this
application today. It is a **manual, admin-only, single-recipient** procedure.
Nothing in the application sends email automatically, in bulk, or on a schedule,
and no automated test ever contacts the real Resend API.

> **Do not run this procedure automatically.** The agent building this feature
> must not send the email itself. A human operator performs these steps.

## Purpose

Prove the full safety chain end to end, with exactly ONE explicit recipient:

```
approved prospect → approved draft → Agent 8 SEND → human approval
→ Agent 10 TRANSPORT_READY → Resend → persisted delivery result
```

## Prerequisites

1. A local run of the app with admin login working.
2. A **controlled** prospect whose recipient email you personally own/verify
   (e.g. a test mailbox) — not a real customer.

## Procedure

### Configure the provider (server-side only)

1. Set `RESEND_API_KEY=<your resend key>` locally (never commit it).
2. Set `RESEND_FROM_EMAIL=<your verified sender address>` locally.
3. Set `EMAIL_TRANSPORT_CONFIGURED=1` and `EMAIL_TRANSPORT_PROVIDER=resend`.
4. Restart the dev server so env changes are read.

### Reach a fully ready prospect

5. Pick your controlled prospect. Confirm its recipient email is:
   - present on the prospect's contact record,
   - status `found`, confidence `high` or `medium`, and is the address you control.
6. Ensure the prospect's campaign is `running` and the prospect is not opted out.
7. Ensure the prospect has a website version that is built, QA-passed, current,
   and deployed to a verified live URL (deployment record status `ready`).

### Create and approve the exact outreach

8. Create a valid outreach draft for the prospect (status `eligible`) using the
   app's existing draft flow.
9. Create a human outreach approval bound exactly to that draft via
   `POST /api/admin/outreach/safety/approve` with the prospect's verified
   recipient email. The approval must match campaign, prospect, draft,
   recipient, content hash and website version.
10. Confirm Agent 8 returns `SEND` and Agent 10 returns `TRANSPORT_READY` for
    this prospect (the orchestrator state should be `READY_FOR_TRANSPORT`).

### Send exactly one email

Two equivalent ways — both trigger the exact same single-recipient send path and
are subject to the exact same safety gates.

11. **Via the admin UI (recommended):** open the History page, select the
    campaign, open your controlled prospect, scroll to the **Outreach Safety**
    section, and click **"Send ONE real email"**. The section shows the current
    safety status (read-only preview from `GET /api/admin/outreach/send-status`,
    which never sends and never writes). The confirmation dialog displays the
    prospect/business, verified recipient email, approved subject, provider and
    safety status — none of those fields are editable. Click **"Confirm & send
    one email"** to POST `confirm: true`.

12. **Via the API:**

    ```http
    POST /api/admin/outreach/send-test
    Content-Type: application/json
    Cookie: aicf_session=<admin session>

    { "prospectId": "<prospect id>", "draftId": "<draft id>", "confirm": true }
    ```

    The server rejects the request unless: the session is a valid admin login,
    the Origin header matches the app origin (CSRF), `confirm` is exactly
    `true`, the campaign is running, there is no opt-out, Agent 8 is `SEND`,
    the outreach approval is valid and exactly bound, Agent 10 is
    `TRANSPORT_READY`, Resend is configured, and the idempotency key is unused.

    Either way, on success the response contains `delivery.messageId` (the
    Resend message id), `delivery.status` = `sent`, `delivery.provider` =
    `resend`, and `idempotencyKey`. Provider failures return a safe normalized
    error code (e.g. `PROVIDER_AUTH_FAILED`) and persist a `failed` row — never
    `sent`.

### Verify

13. Confirm the email arrived in your controlled mailbox.
14. Confirm the persisted delivery record: `outreach_sends` has exactly one row
    for that idempotency key, status `sent`, with the Resend `message_id`.
15. Confirm `provider = "resend"` on that row and that no secret (API key,
    authorization header) is stored anywhere.

## Safety properties (verified by the test suite)

- Exactly one recipient per request; recipient/subject/body/from/version/
  provider are resolved from approved persisted state, never from the browser.
- A second identical request returns a duplicate/blocked result and never
  causes a second Resend call.
- Provider failures are persisted as `failed` and never reported as `sent`.
- Automated tests mock the Resend HTTP boundary; they never send real email.

## Idempotency note

The database idempotency claim guarantees at most one *initiated* provider call
per approved transport action. If the process crashes after Resend accepts the
email but before the local persistence completes, Resend's own delivery may
still occur — so local DB idempotency alone does not guarantee exactly-once
external delivery across such a crash. This is an inherent distributed-system
limitation, not a claim of exactly-once semantics.