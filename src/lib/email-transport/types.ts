/**
 * Email Transport — typed contracts.
 *
 * The transport layer sits below the Agent 10 safety gate. A transport request
 * carries the exact bindings that Agent 10 verified; the transport service
 * re-verifies every binding before delegating to the registered provider.
 *
 * Real providers are intentionally not registered. The only currently supported
 * provider is "mock" — a deterministic simulator that makes zero network calls.
 */

import type { TransportResult } from "@/lib/transport-safety/types";

// ---------------------------------------------------------------------------
// Transport request (what the caller must supply)
// ---------------------------------------------------------------------------

/**
 * A validated transport request carrying enough information to bind the send
 * to the exact approved action. Every field is re-verified against the
 * persisted Agent 10 result before any provider is invoked.
 */
export interface EmailTransportRequest {
  /** Agent 10 transport safety result (must be TRANSPORT_READY). */
  agent10Result: TransportResult;

  /** Campaign the prospect belongs to. */
  campaignId: string;

  /** Prospect (lead) the email is addressed to. */
  prospectId: string;

  /** Exact recipient email (normalized). */
  recipientEmail: string;

  /** Outreach draft id. */
  draftId: string;

  /** Deterministic content hash of the approved draft. */
  contentHash: string;

  /** Current website version id backing the outreach. */
  websiteVersionId: string;

  /** Email subject (already-approved content; must not be rewritten). */
  subject: string;

  /** Email body (already-approved content; must not be rewritten). */
  body: string;

  /** Deterministic idempotency key for this exact send. */
  idempotencyKey: string;

  /** Transport provider id (must be in SUPPORTED_TRANSPORT_PROVIDERS). */
  providerId: string;

  /** Deployment URL backing the outreach. */
  deploymentUrl?: string | null;
}

// ---------------------------------------------------------------------------
// Delivery result (what the provider returns)
// ---------------------------------------------------------------------------

export type DeliveryStatus = "sent" | "simulated" | "failed";

export interface EmailDeliveryResult {
  /** Unique message identifier (deterministic for the mock provider). */
  messageId: string;

  /** Provider that handled the transport. */
  providerId: string;

  /** Delivery status from the provider. */
  status: DeliveryStatus;

  /** ISO-8601 timestamp of the transport attempt. */
  timestamp: string;

  /** The idempotency key this result is bound to. */
  idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// Transport outcome (what the service returns)
// ---------------------------------------------------------------------------

export type TransportOutcomeStatus =
  | "sent"
  | "duplicate"
  | "failed";

export interface EmailTransportOutcome {
  /** Whether the transport succeeded, was a duplicate, or failed. */
  status: TransportOutcomeStatus;

  /** The deterministic delivery result from the provider (if sent). */
  delivery?: EmailDeliveryResult;

  /** Error message when the outcome is "failed". */
  error?: string;

  /** True when the outcome returned a prior result for the same idempotency key. */
  isDuplicate: boolean;

  /** The idempotency key for this transport. */
  idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

/**
 * Email transport provider adapter. One implementation per provider.
 * The transport service depends only on this interface; adding a real provider
 * means implementing this and registering it.
 *
 * Providers are never called with arbitrary client-supplied configuration —
 * credentials are read server-side and never flow through the wire types.
 * Every method may throw EmailTransportError with a safe message.
 */
export interface EmailTransportProvider {
  /** Unique provider identifier (must be in SUPPORTED_TRANSPORT_PROVIDERS). */
  readonly providerId: string;

  /** Human-readable label. */
  readonly providerLabel: string;

  /** True for the dev/test mock provider. Never a real transport. */
  readonly isMock: boolean;

  /**
   * Delivers the email. For the mock provider this is a deterministic
   * simulation with zero network calls.
   */
  send(request: EmailTransportRequest): Promise<EmailDeliveryResult>;

  /** Read-only inspection of a prior delivery. */
  inspect(idempotencyKey: string): Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Provider registry summary
// ---------------------------------------------------------------------------

export interface EmailProviderSummary {
  id: string;
  label: string;
  isMock: boolean;
}

// ---------------------------------------------------------------------------
// Transport service options
// ---------------------------------------------------------------------------

export interface EmailTransportOptions {
  /** Override the provider registry (tests). */
  providerOverride?: EmailTransportProvider;
}
