/**
 * Email Transport Service (Step 17).
 *
 * The transport service sits directly below the Agent 10 safety gate. It is
 * the ONLY component that ever invokes an email transport provider; all prior
 * safety decisions (A8 send-safety, A9 orchestrator, A10 transport-safety)
 * MUST have passed before this service is called.
 *
 * The service re-verifies every binding in the transport request against the
 * persisted Agent 10 result: mismatched prospect, draft, recipient, campaign,
 * content hash, website version, approval, or provider is rejected fail-closed.
 * The same idempotency key can never produce a second simulated send —
 * duplicate requests return the existing result via the atomic send-claim
 * pattern in `outreach_sends`.
 *
 * Subject and body are treated as already-approved content. The service never
 * rewrites, regenerates, or injects into them. If the content hash does not
 * match the persisted draft, the request is rejected fail-closed.
 *
 * The only registered provider is "mock" — a deterministic simulator that
 * performs zero network calls and never sends a real email. Real providers are
 * intentionally not registered; any future provider must implement
 * `EmailTransportProvider` and be added to the provider registry before the
 * transport service will accept it.
 */

import {
  recordSendAuthorization,
  getOutreachSendByKey,
  claimOutreachSendForTransport,
  updateOutreachSend,
  getOutreachDraft,
  buildIdempotencyKey,
  hashOutreachDraft,
  type OutreachSendStatus,
} from "@/lib/data/outreach";
import { logActivity } from "@/lib/data/activity";
import { normalizeRecipientEmail } from "@/lib/outreach-safety/safety";
import { MockEmailTransportProvider } from "@/lib/email-transport/providers/mock";
import type {
  EmailDeliveryResult,
  EmailTransportOptions,
  EmailTransportOutcome,
  EmailTransportProvider,
  EmailTransportRequest,
} from "@/lib/email-transport/types";
import { SUPPORTED_TRANSPORT_PROVIDERS } from "@/lib/transport-safety/types";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class EmailTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailTransportError";
  }
}

// ---------------------------------------------------------------------------
// Provider registry (only "mock" is registered)
// ---------------------------------------------------------------------------

const MOCK_PROVIDER = new MockEmailTransportProvider();
const REGISTERED_PROVIDERS = new Map<string, EmailTransportProvider>([
  ["mock", MOCK_PROVIDER],
]);

function getProvider(id: string): EmailTransportProvider | null {
  return REGISTERED_PROVIDERS.get(id) ?? null;
}

export function listRegisteredProviders(): Array<{
  id: string;
  label: string;
  isMock: boolean;
}> {
  return [...REGISTERED_PROVIDERS.values()].map((p) => ({
    id: p.providerId,
    label: p.providerLabel,
    isMock: p.isMock,
  }));
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/**
 * Validates that the transport request matches the Agent 10 result exactly.
 * Throws EmailTransportError on any binding mismatch — the request fails
 * closed before any provider is invoked.
 */
function validateRequest(request: EmailTransportRequest): void {
  const a10 = request.agent10Result;

  if (!a10 || typeof a10 !== "object") {
    throw new EmailTransportError(
      "No Agent 10 transport safety result was provided; transport fails closed.",
    );
  }

  if (a10.decision !== "TRANSPORT_READY") {
    throw new EmailTransportError(
      `Agent 10 decision is "${a10.decision}" (expected TRANSPORT_READY); transport is not permitted.`,
    );
  }

  if (a10.execute !== false) {
    throw new EmailTransportError(
      "Agent 10 result has execute !== false; transport is not permitted.",
    );
  }

  if (a10.prospectId !== request.prospectId) {
    throw new EmailTransportError(
      `Prospect binding mismatch: request prospect "${request.prospectId}" differs from Agent 10 result "${a10.prospectId}".`,
    );
  }

  if (a10.draftId !== request.draftId) {
    throw new EmailTransportError(
      `Draft binding mismatch: request draft "${request.draftId}" differs from Agent 10 result "${a10.draftId}".`,
    );
  }

  if (a10.recipient.email !== request.recipientEmail) {
    throw new EmailTransportError(
      `Recipient binding mismatch: request recipient "${request.recipientEmail}" differs from Agent 10 result "${a10.recipient.email}".`,
    );
  }

  if (a10.campaignId !== request.campaignId) {
    throw new EmailTransportError(
      `Campaign binding mismatch: request campaign "${request.campaignId}" differs from Agent 10 result "${a10.campaignId}".`,
    );
  }

  if (a10.provider.id !== request.providerId) {
    throw new EmailTransportError(
      `Provider binding mismatch: request provider "${request.providerId}" differs from Agent 10 result "${a10.provider.id}".`,
    );
  }

  if (!a10.approval.valid) {
    throw new EmailTransportError(
      "Agent 10 result reports approval is not valid; transport is not permitted.",
    );
  }

  if (!a10.approval.boundToDraft) {
    throw new EmailTransportError(
      "Agent 10 result reports approval is not bound to the draft; transport is not permitted.",
    );
  }

  if (!a10.approval.boundToRecipient) {
    throw new EmailTransportError(
      "Agent 10 result reports approval is not bound to the recipient; transport is not permitted.",
    );
  }

  if (!a10.approval.boundToProspect) {
    throw new EmailTransportError(
      "Agent 10 result reports approval is not bound to the prospect; transport is not permitted.",
    );
  }

  if (a10.agent8.decision !== "SEND") {
    throw new EmailTransportError(
      `Agent 8 decision is "${a10.agent8.decision}" (expected SEND); transport is not permitted.`,
    );
  }

  if (a10.website.currentVersionId !== request.websiteVersionId) {
    throw new EmailTransportError(
      `Website version binding mismatch: request version "${request.websiteVersionId}" differs from Agent 10 result "${a10.website.currentVersionId}".`,
    );
  }

  if (a10.duplicate.alreadyProcessed) {
    throw new EmailTransportError(
      "Agent 10 reports this exact outreach was already processed; transport is not permitted.",
    );
  }

  if (!a10.website.ready) {
    throw new EmailTransportError(
      "Agent 10 result reports the website is not ready; transport is not permitted.",
    );
  }
}

/**
 * Validates the transport request content against the persisted draft and
 * verifies that subject/body have not been modified since approval.
 */
function validateContent(request: EmailTransportRequest): void {
  if (!(SUPPORTED_TRANSPORT_PROVIDERS as readonly string[]).includes(request.providerId)) {
    throw new EmailTransportError(
      `Transport provider "${request.providerId}" is not supported.`,
    );
  }

  const draft = getOutreachDraft(request.draftId);
  if (!draft) {
    throw new EmailTransportError(
      `Draft "${request.draftId}" not found; transport fails closed.`,
    );
  }

  if (draft.leadId !== request.prospectId) {
    throw new EmailTransportError(
      `Draft does not belong to prospect "${request.prospectId}".`,
    );
  }

  if (draft.status !== "eligible") {
    throw new EmailTransportError(
      `Draft status is "${draft.status}" (expected "eligible"); transport is not permitted.`,
    );
  }

  if (draft.subject !== request.subject) {
    throw new EmailTransportError(
      "Request subject does not match the persisted draft; transport must not rewrite content.",
    );
  }

  if (draft.body !== request.body) {
    throw new EmailTransportError(
      "Request body does not match the persisted draft; transport must not rewrite content.",
    );
  }

  const recomputedHash = hashOutreachDraft(draft.subject, draft.body);
  if (!draft.contentHash || recomputedHash !== draft.contentHash) {
    throw new EmailTransportError(
      "Draft content hash mismatch; draft may have been tampered with.",
    );
  }

  if (request.contentHash !== draft.contentHash) {
    throw new EmailTransportError(
      "Request content hash does not match the persisted draft hash.",
    );
  }

  const expectedKey = buildIdempotencyKey({
    leadId: request.prospectId,
    draftId: request.draftId,
    recipientEmail: normalizeRecipientEmail(request.recipientEmail),
    draftHash: draft.contentHash,
  });
  if (request.idempotencyKey !== expectedKey) {
    throw new EmailTransportError(
      "Request idempotency key does not match the computed key for this exact outreach.",
    );
  }
}

// ---------------------------------------------------------------------------
// Transport service
// ---------------------------------------------------------------------------

/**
 * Attempts to deliver (or simulate delivery of) an approved email via the
 * registered transport provider. The service re-verifies all safety-gate
 * bindings before delegating to the provider, persists the transport attempt
 * for idempotency, and returns a safe outcome.
 *
 * Every failure path throws `EmailTransportError` and produces no DB writes
 * and no provider calls. Duplicate requests (same idempotency key) return
 * the existing result without re-invoking the provider.
 */
export async function transportEmail(
  request: EmailTransportRequest,
  options: EmailTransportOptions = {},
): Promise<EmailTransportOutcome> {
  // --- fast path: unsupported provider ------------------------------------
  if (!(SUPPORTED_TRANSPORT_PROVIDERS as readonly string[]).includes(request.providerId)) {
    throw new EmailTransportError(
      `Transport provider "${request.providerId}" is not supported; transport is rejected.`,
    );
  }

  // --- Agent 10 binding verification (fail-closed) -----------------------
  validateRequest(request);

  // --- content integrity verification ------------------------------------
  validateContent(request);

  // --- idempotency claim (atomic) ----------------------------------------
  const key = request.idempotencyKey;

  // Check for an existing row first (fast path for duplicates).
  const existing = getOutreachSendByKey(key);
  if (existing) {
    if (existing.status === "sent" || existing.status === "blocked") {
      const existingDelivery: EmailDeliveryResult = {
        messageId: existing.messageId ?? "",
        providerId: existing.provider ?? request.providerId,
        status: existing.status === "sent" ? "simulated" : "failed",
        timestamp: existing.updatedAt,
        idempotencyKey: existing.idempotencyKey,
      };
      return {
        status: "duplicate",
        delivery: existingDelivery,
        isDuplicate: true,
        idempotencyKey: key,
      };
    }

    if (existing.status === "sending") {
      return {
        status: "duplicate",
        isDuplicate: true,
        idempotencyKey: key,
      };
    }
  }

  // Either no row exists (fresh claim) or row is in authorized/failed status
  // (claimable). The atomic claim ensures at most one caller proceeds to the
  // provider for a given idempotency key.
  const claimResult = claimOrInsert(key, request);
  if (!claimResult) {
    return {
      status: "duplicate",
      isDuplicate: true,
      idempotencyKey: key,
    };
  }

  const sendId = claimResult.id;
  const provider =
    options.providerOverride ?? getProvider(request.providerId) ?? null;

  if (!provider) {
    throw new EmailTransportError(
      `No provider is registered for "${request.providerId}".`,
    );
  }

  // --- invoke provider ----------------------------------------------------
  let delivery: EmailDeliveryResult;
  try {
    delivery = await provider.send(request);
  } catch (error) {
    updateOutreachSend(sendId, {
      status: "failed",
      failureReason:
        error instanceof Error ? error.message : "Provider call failed.",
      provider: request.providerId,
    });
    throw new EmailTransportError(
      `Transport provider "${request.providerId}" failed: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
  }

  // --- persist result -----------------------------------------------------
  updateOutreachSend(sendId, {
    status: "sent",
    provider: request.providerId,
    messageId: delivery.messageId,
  });

  logActivity({
    action: "email_transport.sent",
    campaignId: request.campaignId,
    leadId: request.prospectId,
    metadata: {
      messageId: delivery.messageId,
      provider: request.providerId,
      draftId: request.draftId,
      idempotencyKey: key,
    },
  });

  return {
    status: "sent",
    delivery,
    isDuplicate: false,
    idempotencyKey: key,
  };
}

// ---------------------------------------------------------------------------
// Atomic claim-or-insert
// ---------------------------------------------------------------------------

function claimOrInsert(
  key: string,
  request: EmailTransportRequest,
): { id: string } | null {
  const existing = getOutreachSendByKey(key);
  if (existing) {
    if (existing.status === "sent" || existing.status === "blocked") {
      return null;
    }
    if (existing.status === "sending") {
      return null;
    }
    const claimed = claimOutreachSendForTransport(existing.id);
    if (!claimed) return null;
    return { id: claimed.id };
  }

  // No row exists — insert with status "sending" (the claim). The UNIQUE
  // idempotency key constraint is the ultimate backstop: if a concurrent caller
  // inserted between our read and write, the INSERT throws and we return null.
  try {
    const row = recordSendAuthorization({
      leadId: request.prospectId,
      draftId: request.draftId,
      recipientEmail: normalizeRecipientEmail(request.recipientEmail),
      draftHash: request.contentHash,
      idempotencyKey: key,
      decision: "SEND",
      status: "sending" as OutreachSendStatus,
      websiteVersionId: request.websiteVersionId,
      deploymentUrl: request.deploymentUrl ?? null,
    });
    return { id: row.id };
  } catch {
    // UNIQUE constraint violation: a concurrent caller won the race. Re-read
    // to determine the winner's status.
    const raceWinner = getOutreachSendByKey(key);
    if (!raceWinner) return null;
    if (raceWinner.status === "sent" || raceWinner.status === "blocked") {
      return null;
    }
    if (raceWinner.status === "sending") {
      return null;
    }
    // Race winner is in authorized/failed (rare); try to claim.
    const claimed = claimOutreachSendForTransport(raceWinner.id);
    return claimed ? { id: claimed.id } : null;
  }
}
