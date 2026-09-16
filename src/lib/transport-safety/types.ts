/**
 * Transport Safety (Agent 10) — typed contracts.
 *
 * Agent 10 is the pre-transport gate in front of READY_FOR_TRANSPORT. It
 * independently re-verifies every condition that must hold BEFORE any future
 * email transport could be consumed: a stopped/paused campaign overrides
 * everything, the prospect and exact outreach are approved and unchanged, no
 * opt-out or duplicate exists, the website version/deployment backing the
 * outreach is valid, and an explicit, supported transport provider is
 * configured — evaluated last, so provider configuration can never override a
 * safety decision.
 *
 * The engine is PURE and DETERMINISTIC: it only reads trusted application
 * state (never writes, never calls a provider, never sends anything). Every
 * result carries `execute: false`.
 */

export type TransportDecision =
  | "TRANSPORT_READY"
  | "WAIT"
  | "REJECT"
  | "SKIP_PROSPECT";

/**
 * The only transport provider identifiers this gate recognises. "mock" is the
 * dev/test identifier (always registered, zero network). "resend" is a real
 * provider identifier that is only granted READY status when the Resend
 * adapter is configured server-side. No provider can ever be claimed as
 * "configured" — and nothing is ever sent — until the adapter exists AND is
 * configured AND every safety gate passes. Provider configuration is evaluated
 * LAST and can never override a safety decision.
 */
export const SUPPORTED_TRANSPORT_PROVIDERS = ["mock", "resend"] as const;

export type SupportedTransportProvider =
  (typeof SUPPORTED_TRANSPORT_PROVIDERS)[number];

export interface TransportCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface TransportApprovalStatus {
  required: boolean;
  valid: boolean;
  boundToDraft: boolean;
  boundToRecipient: boolean;
  boundToProspect: boolean;
}

export interface TransportProviderStatus {
  id: string | null;
  supported: boolean;
  configured: boolean;
}

export interface TransportWebsiteStatus {
  currentVersionId: string | null;
  deploymentUrl: string | null;
  deploymentStatus: string | null;
  /** True when the current version has a ready deployment backing it. */
  ready: boolean;
}

export interface TransportResult {
  decision: TransportDecision;
  /** Stable machine-readable code for the outcome. */
  code: string;
  reason: string;
  prospectId: string;
  draftId: string | null;
  campaignId: string | null;
  recipient: { email: string };
  approval: TransportApprovalStatus;
  agent8: { decision: string | null };
  provider: TransportProviderStatus;
  website: TransportWebsiteStatus;
  duplicate: { key: string; alreadyProcessed: boolean };
  blockingIssues: string[];
  checks: TransportCheck[];
  /** Always false: this decision can never order a send. */
  execute: false;
}

export interface TransportSafetyInput {
  leadId: string;
  /** The exact outreach draft to evaluate (bound to prospect + hash). */
  draftId?: string;
  /** Normalized candidate recipient email. */
  recipientEmail?: string;
  /** Explicit campaign context; must match the prospect's campaign. */
  campaignId?: string | null;
  /**
   * The trusted Agent 8 outreach decision (SEND | WAIT | WAIT_FOR_APPROVAL |
   * REJECT | SKIP_PROSPECT). Absent/unknown values fail closed to REJECT: a
   * candidate cannot self-authorize by omitting it.
   */
  agent8Decision?: string | null;
  /** Provider id from the (future) transport configuration layer. */
  provider?: string | null;
  /** Untrusted prospect reply; may only ever block (e.g. opt-out). */
  replyText?: string;
  /** Untrusted context; can never authorize anything. */
  untrustedContext?: Record<string, unknown>;
  /** Ignored: input can never enable execution. */
  execute?: boolean;
}

export interface TransportSafetyOptions {
  /** Durable stop requested by the job controller; overrides everything. */
  stopRequested?: boolean;
  /** Whether the transport provider is actually configured. Defaults to env. */
  transportConfigured?: boolean;
}