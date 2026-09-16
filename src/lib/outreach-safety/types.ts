export type OutreachDecision =
  | "SEND"
  | "WAIT_FOR_APPROVAL"
  | "WAIT"
  | "REJECT"
  | "SKIP_PROSPECT";

export type CampaignRunState = "running" | "paused" | "stopped";

export interface OutreachCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface OutreachApprovalStatus {
  required: boolean;
  valid: boolean;
  boundToDraft: boolean;
  boundToRecipient: boolean;
  boundToProspect: boolean;
}

export interface OutreachIdempotencyStatus {
  key: string;
  alreadyProcessed: boolean;
}

export interface OutreachSafetyResult {
  decision: OutreachDecision;
  eligibleToSend: boolean;
  reason: string;
  prospectId: string;
  draftId: string;
  recipient: { email: string };
  approval: OutreachApprovalStatus;
  blockingIssues: string[];
  checks: OutreachCheck[];
  idempotency: OutreachIdempotencyStatus;
  execute: false;
}

export interface SafetyEvaluationInput {
  leadId: string;
  draftId: string;
  recipientEmail?: string;
  replyText?: string;
  untrustedContext?: Record<string, unknown>;
}

export interface SafetyEvaluationOptions {
  transportAvailable?: boolean;
  stopRequested?: boolean;
  recordAuthorization?: boolean;
  verifiedServices?: string[];
}
