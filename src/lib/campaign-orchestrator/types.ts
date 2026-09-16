/**
 * Campaign Orchestrator (Agent 9 / Step 15) — shared types.
 *
 * The orchestrator is a deterministic coordinator: for a single prospect it
 * reports the next legal state in the campaign state machine. It performs no
 * side effects, never sends email, never deploys, and can never authorize
 * anything. Every result carries `execute: false`.
 */

export type CampaignState =
  | "DISCOVER_LEADS"
  | "QUALIFY_LEADS"
  | "RESEARCH_BUSINESS"
  | "CREATE_WEBSITE"
  | "CODE_WEBSITE"
  | "RUN_WEBSITE_QA"
  | "FIX_WEBSITE"
  | "CHECK_DEPLOYMENT_ELIGIBILITY"
  | "WAIT_FOR_DEPLOYMENT_APPROVAL"
  | "DEPLOY_WEBSITE"
  | "CREATE_OUTREACH_DRAFT"
  | "CHECK_OUTREACH_SAFETY"
  | "WAIT_FOR_OUTREACH_APPROVAL"
  | "READY_FOR_TRANSPORT"
  | "WAIT"
  | "RETRY_STEP"
  | "SKIP_PROSPECT"
  | "STOP"
  | "COMPLETE";

export interface OrchestratorCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface OrchestratorResult {
  leadId: string;
  campaignId: string | null;
  /** The next legal action for this prospect. Never an execution. */
  state: CampaignState;
  /** Deterministic human-readable justification. */
  reason: string;
  /** Short instruction describing what may be done next. */
  nextAction: string;
  /** Every gate that was evaluated along the way (passed/failed). */
  checks: OrchestratorCheck[];
  /** Reasons that forced the current non-progressing state. */
  blockingIssues: string[];
  /** Always false: this is a decision, never an order to execute. */
  execute: false;
  iteration: number;
}

export interface OrchestratorInput {
  leadId: string;
  /**
   * Optional explicit campaign context. When provided and the lead is not part
   * of this campaign the evaluation fails closed (nothing can proceed).
   */
  campaignId?: string | null;
  /** Loop iteration counter, surfaced for checkpointing only. */
  iteration?: number;
  /** Untrusted prospect reply text; can only ever block (e.g. opt-out). */
  replyText?: string;
  /** Untrusted context that can never authorize anything. */
  untrustedContext?: Record<string, unknown>;
}

export interface OrchestratorOptions {
  /** Durable stop requested by the job controller; overrides everything. */
  stopRequested?: boolean;
  /** Passed through to the outreach safety evaluation. */
  transportAvailable?: boolean;
}