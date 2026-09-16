# Email Transport (Step 17)

Production transport abstraction with a deterministic mock provider. The only
currently registered provider is `mock` — it performs zero network calls and
never sends a real email.

## Architecture

```
A10 Transport Safety (TRANSPORT_READY)
        ↓
Transport intent
        ↓
Email Transport Service (transportEmail)
        ↓
Provider registry  →  MockProvider
        ↓
deterministic simulated delivery
```

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
- `providerId` — transport provider id (must be "mock")

## Agent 10 dependency

The service requires `agent10Result.decision === "TRANSPORT_READY"`. Any other
decision (WAIT, REJECT, SKIP_PROSPECT) or a missing/absent Agent 10 result
causes the service to fail closed — no provider is called and no DB row is
written.

The service re-verifies every binding in the request against the Agent 10
result: mismatched prospect, draft, recipient, campaign, content hash, website
version, approval, or provider is rejected fail-closed.

## Provider registry

Only `mock` is registered. Real providers are intentionally not registered.

```
mock  — deterministic simulated delivery (zero network)
```

Adding a real provider in the future requires:
1. Implement `EmailTransportProvider` interface.
2. Register it in the provider registry in `service.ts`.
3. Add its id to `SUPPORTED_TRANSPORT_PROVIDERS` in `transport-safety/types.ts`.
4. Set `EMAIL_TRANSPORT_PROVIDER=<id>` and `EMAIL_TRANSPORT_CONFIGURED=1` in env.

## Idempotency

The same `idempotencyKey` never produces two simulated sends. The service uses
an atomic claim pattern on the `outreach_sends` table:

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

## Security

The transport service never:
- Executes shell commands.
- Fetches arbitrary URLs.
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
- Unknown/real provider names → reject.
- Subject/body not modified.
- Zero network calls.
- No actual email side effects.
