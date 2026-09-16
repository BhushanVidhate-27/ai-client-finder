# Transport Safety (Agent 10)

A pure, deterministic pre-transport gate. Before a prospect can ever be marked
`READY_FOR_TRANSPORT`, Agent 10 independently re-verifies that the exact
outreach is approved, unchanged, duplicate-free, not opted-out, backed by a
verified live deployment, and that an explicit supported transport provider is
configured.

## Decisions

| Decision          | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `TRANSPORT_READY` | All gates passed; the outreach may be marked ready for transport.       |
| `WAIT`            | Not broken, just not ready yet (no approval, provider unconfigured, …). |
| `REJECT`          | A hard condition was violated; transport is not permitted.              |
| `SKIP_PROSPECT`   | The prospect may no longer be contacted (opt-out, A8 skipped).          |

The campaign state-machine mapping is:

```
TRANSPORT_READY -> READY_FOR_TRANSPORT
WAIT            -> WAIT
REJECT          -> SKIP_PROSPECT
SKIP_PROSPECT   -> SKIP_PROSPECT
```

## Hard guarantees (enforced in code, tested in `tests/transport-safety.test.ts`)

- **No side effects.** The engine only reads trusted DB state. It never writes
  (no sends, no authorizations, no deployments), never calls an email provider,
  never performs network/shell/Gemini work, and can never produce `execute:
  true`.
- **Stopped beats everything.** `stopRequested` and a `STOPPED` campaign are
  checked before any readiness logic; a `PAUSED` campaign forces `WAIT`.
- **Provider configuration is evaluated LAST.** A configured provider can never
  override a stop, opt-out, duplicate, binding, or any other safety gate.
- **Untrusted text can only block.** `replyText`, `untrustedContext`, a fake
  `execute: true`, or "approval-looking" copy can never raise the decision.
  Only the trusted `agent8Decision === "SEND"` input from Agent 8 (plus exact
  stored approvals) can contribute to readiness.
- **Exact bindings only.** The outreach approval must match the lead, draft,
  recipient and draft hash; the deployment approval must match the current
  website version and artifact hash; the campaign context must match the
  prospect's campaign; cross-prospect/cross-campaign approvals never transfer.
- **Duplicate transport is blocked** via the existing `outreach_sends`
  idempotency (same lead + draft + recipient + hash).

## Gate order

1. `stopRequested`
2. prospect exists + eligible
3. opt-out (recorded and/or in reply)
4. campaign: exists / not stopped / not paused / context match
5. recipient: present, well-formed, verified
6. draft: exists, belongs to prospect, eligible
7. Agent 8 decision == `SEND` (anything else → WAIT/REJECT/SKIP)
8. duplicate / idempotency
9. website version exists + ready deployment for the current version +
   valid deployment approval for the exact version/artifact
10. outreach approval: present, valid, not expired, exactly bound
11. provider id present, supported, and configured — **last**

## Provider configuration

- `EMAIL_TRANSPORT_PROVIDER` (env) or `input.provider` selects the provider id.
- `EMAIL_TRANSPORT_CONFIGURED` (`1`/`true`) or `options.transportConfigured`
  marks it configured.
- `SUPPORTED_TRANSPORT_PROVIDERS` currently contains only `"mock"`. No
  transport adapter is implemented anywhere in this repository — these are
  identifiers used by the gate so that unsupported providers are rejected
  (`REJECT`) and unconfigured ones wait (`WAIT`). Adding a real adapter is a
  separate, future step.

## Integration

Agent 9 (`evaluateNextAction` in `src/lib/campaign-orchestrator/evaluate.ts`)
runs the gate whenever Agent 8 returns `SEND`. `READY_FOR_TRANSPORT` is
unreachable unless Agent 10 also returns `TRANSPORT_READY`, so Agent 9 can
never bypass Agent 10. Nothing sends email; `execute` is always `false`.