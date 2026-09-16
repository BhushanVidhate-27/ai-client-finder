/**
 * Outreach Send Safety (Agent 8).
 *
 * Public surface for the outreach send-safety module. Everything a consumer
 * needs to run a deterministic safety evaluation and understand its result.
 */

export {
  evaluateSendSafety,
  normalizeRecipientEmail,
  isValidRecipientEmail,
  mapCampaignRunState,
} from "@/lib/outreach-safety/safety";
export {
  detectOptOutSignal,
  detectInjectionAttempts,
  scanDraftContent,
  LIVE_SITE_CLAIM_PATTERN,
} from "@/lib/outreach-safety/content-safety";
export { createOutreachSafetyAgent } from "@/lib/outreach-safety/agent";
export { OutreachSafetyError, DuplicateSendAuthorizationError } from "@/lib/outreach-safety/errors";
export type {
  OutreachDecision,
  CampaignRunState,
  OutreachCheck,
  OutreachApprovalStatus,
  OutreachIdempotencyStatus,
  OutreachSafetyResult,
  SafetyEvaluationInput,
  SafetyEvaluationOptions,
} from "@/lib/outreach-safety/types";