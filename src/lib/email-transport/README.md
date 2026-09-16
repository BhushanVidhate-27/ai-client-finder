# Email Transport (Step 17)

Production transport abstraction with a deterministic mock provider and a
Resend adapter that is registered **only when server-configured**. Real sending
is never automatic: nothing sends email unless an explicit, fully validated
transport request is made and every safety gate has passed.

## Architecture

```
A10 Transport Safety (TRANSPORT_READY)
        ↓
Transport intent
        ↓
Email Transport Service (transportEmail)
        ↓
Provider registry  →  MockProvider | ResendProvider (when configured)
        ↓
deterministic simulated delivery   |   Resend API (never automatic)
```

## Provider registry

Providers are an explicit allowlist:

```
mock   — deterministic simulated delivery (zero network), always registered
resend — real provider, registered only when RESEND_API_KEY is set
```

The Resend adapter is registered **only when `RESEND_API_KEY` is configured**.
Agent 10 marks the provider "configured" only when both `RESEND_API_KEY` and
`RESEND_FROM_EMAIL` are present — configuration alone never authorizes sending.

Adding a real provider requires:
1. Implement `EmailTransportProvider` interface.
2. Register it in the provider registry in `service.ts`.
3. Add its id to `SUPPORTED_TRANSPORT_PROVIDERS` in `transport-safety/types.ts`.
4. Set `EMAIL_TRANSPORT_PROVIDER=<id>` and `EMAIL_TRANSPORT_CONFIGURED=1` in env.

## Transport request

A transport request contains enough information to bind the send to the exact
approved action:

- `agent10Result` — the Agent 10 `TransportResult` with `decision === "TRANSPORT_READY"`
- `campaignId` — campaign the prospect belongs to
- `prospectId` — prospect (lead) the email is addressed to
- `recipientEmail` — exact recipient email (normalized)
- `draftId` — outreach draft id
- `contentHash` — deterministic SHA-256 of the approved draft
- `websiteVersionId` — current website version backing the outreach
- `subject` / `body` — already-approved email content
- `idempotencyKey` — deterministic key for this exact send
- `providerId` — transport provider id (must be "mock" or "resend")

## Agent 10 dependency

The service requires `agent10Result.decision === "TRANSPORT_READY"`. Any other
decision (WAIT, REJECT, SKIP_PROSPECT) or a missing/absent Agent 10 result
causes the service to fail closed — no provider is called and no DB row is
written.

The service re-verifies every binding in the request against the Agent 10
result: mismatched prospect, draft, recipient, campaign, content hash, website
version, approval, or provider is rejected fail-closed.

## Provider registry

Only configured providers appear. `mock` is always registered. `resend` is
registered only when `RESEND_API_KEY` is set.

```
mock   — deterministic simulated delivery (zero network)
resend — real provider adapter (registered only when server-configured)
```

## Idempotency

The same `idempotencyKey` never produces two sends (simulated or real). The
service uses an atomic claim pattern on the `outreach_sends` table:

1. Check if a row already exists for the key.
2. If it exists and status is `sent`/`blocked` → return existing (duplicate).
3. If it exists and status is `authorized`/`failed` → atomically claim it to
   `sending` via a guarded `UPDATE` (only the first caller wins).
4. If it doesn't exist → insert with status `sending`. The UNIQUE idempotency
   key constraint is the ultimate backstop against concurrent insert races.
5. Call the provider.
6. Update the row to `sent` with provider and message id.

## State machine

```
  authorized ──→ sending ──→ sent
                   │
                   └──→ failed
  failed ──→ sending (retry) ──→ sent
  sending (concurrent) → duplicate (second caller returns existing)
```

Legal transitions:
- `authorized → sending` (fresh claim)
- `failed → sending` (explicit retry)
- `sending → sent` (provider success)
- `sending → failed` (provider error)
- `sent / blocked → [no transition]` (terminal)

## Mock provider

- Deterministic message id derived from the idempotency key.
- Delivery status: `simulated`.
- Zero network calls.
- Zero external API calls.
- Zero real emails.
- Email subject and body are never modified by the provider.

## Resend provider (Step 18)

- Real provider adapter; registered only when `RESEND_API_KEY` is set.
- Sends exactly the approved subject/body/recipient; never rewrites content.
- From address comes only from `RESEND_FROM_EMAIL` (server config).
- API key is read server-side, never logged, never exposed to clients, never
  persisted, and never included in error messages or API responses.
- Provider failures are normalized into safe internal codes
  (`PROVIDER_NOT_CONFIGURED`, `PROVIDER_AUTH_FAILED`, `PROVIDER_RATE_LIMITED`,
  `PROVIDER_REJECTED`, `PROVIDER_NETWORK_ERROR`, `PROVIDER_UNKNOWN_ERROR`).
- Calling the adapter requires a fully validated `EmailTransportRequest` whose
  `agent10Result.decision === "TRANSPORT_READY"` — all safety gates (Agent 8
  SEND, Agent 9, Agent 10, human approval, opt-out, STOP/PAUSE, draft/recipient/
  version/deployment bindings, idempotency) must have passed. Configuration alone
  never authorizes sending.
- Real sending is not enabled by default: the runner stops at
  `READY_FOR_TRANSPORT`, no automatic or bulk sending exists, and `mock`
  remains the dev/test default.

## Security

The transport service never:
- Executes shell commands.
- Fetches arbitrary URLs (Resend HTTP goes only to the fixed Resend endpoint).
- Calls arbitrary APIs.
- Logs credentials.
- Accepts arbitrary provider implementations from user input.
- Trusts provider configuration over Agent 10 safety decisions.
- Rewrites or regenerates email content.

## Testing

Run all tests:
```
npx vitest run
```

The email transport tests (`tests/email-transport.test.ts`) cover all
specified scenarios (A–AD), including:
- Valid transport → mock simulated send.
- Non-TRANSPORT_READY decisions → no send.
- Missing Agent 10 result → reject.
- All binding mismatches → reject.
- Content hash tampering → reject.
- Duplicate idempotency → exactly one simulated send.
- Unknown/unsupported provider names → reject.
- Subject/body not modified.
- Zero network calls.
- No actual email side effects.

The Resend adapter tests (`tests/resend-transport.test.ts`) cover the real
provider contract with a mocked HTTP boundary — no real Resend API call and no
real email is ever attempted by the test suite.
