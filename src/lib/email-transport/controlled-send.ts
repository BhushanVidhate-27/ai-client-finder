/**
 * Controlled Single-Email Delivery (Step 19).
 *
 * A strictly admin-controlled, single-recipient send path that proves the full
 * safety chain end-to-end: approved prospect → approved draft → Agent 8 SEND →
 * human outreach approval → Agent 10 TRANSPORT_READY → Resend → persisted
 * delivery result.
 *
 * It is NOT bulk sending, NOT automatic campaign sending, NOT scheduled
 * sending, and NOT a campaign worker. It sends exactly one email to exactly
 * one recipient, and only when every existing safety gate passes.
 *
 * The service accepts only `prospectId` + `draftId` (+ explicit confirmation).
 * Every other value — recipient, subject, body, from address, content hash,
 * website version, approval binding, campaign context, provider — is resolved
 * exclusively from trusted persisted server state. Nothing from the browser is
 * authoritative.
 */

import { getLeadById } from "@/lib/data/leads";
import { getCampaign, listCampaignIdsByLeadId } from "@/lib/data/campaigns";
import {
  buildIdempotencyKey,
  getOutreachDraft,
} from "@/lib/data/outreach";
import {
  evaluateSendSafety,
  mapCampaignRunState,
  normalizeRecipientEmail,
} from "@/lib/outreach-safety/safety";
import { evaluateTransportSafety } from "@/lib/transport-safety";
import { transportEmail, EmailTransportError } from "@/lib/email-transport/service";
import type { EmailTransportOutcome } from "@/lib/email-transport/types";

// ---------------------------------------------------------------------------
// Input / error types
// ---------------------------------------------------------------------------

export interface ControlledSendInput {
  /** The prospect (lead) to send to. */
  prospectId: string;
  /** The approved outreach draft to send. */
  draftId: string;
  /** Explicit human confirmation. Must be exactly true. */
  confirm: boolean;
}

/**
 * Safe, stable error categories for the controlled send path. Provider-level
 * failures carry their normalized EmailTransportError code instead.
 */
export type ControlledSendBlockedCode =
  | "CONFIRM_REQUIRED"
  | "PROSPECT_NOT_FOUND"
  | "DRAFT_NOT_FOUND"
  | "DRAFT_LEAD_MISMATCH"
  | "NO_CAMPAIGN"
  | "CAMPAIGN_NOT_RUNNING"
  | "RECIPIENT_NOT_VERIFIED"
  | "AGENT8_NOT_SEND"
  | "AGENT10_NOT_READY"
  | "RESEND_NOT_CONFIGURED";

export class ControlledSendBlockedError extends Error {
  readonly code: ControlledSendBlockedCode;
  readonly httpStatus: number;

  constructor(code: ControlledSendBlockedCode, httpStatus: number, reason: string) {
    super(reason);
    this.name = "ControlledSendBlockedError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function blocked(
  code: ControlledSendBlockedCode,
  httpStatus: number,
  reason: string,
): ControlledSendBlockedError {
  return new ControlledSendBlockedError(code, httpStatus, reason);
}

export interface ControlledSendResult {
  /** "sent" when the single email was delivered, "duplicate" when a prior
   *  successful delivery already exists for this exact transport. */
  status: "sent" | "duplicate";
  /** The transport outcome (already persisted by transportEmail). */
  outcome: EmailTransportOutcome;
}

// ---------------------------------------------------------------------------
// Controlled send
// ---------------------------------------------------------------------------

/**
 * Single-recipient send entry point. Re-runs the authoritative safety chain
 * (Agent 8 → Agent 10 → TRANSPORT_READY) from persisted state, then hands the
 * server-built transport request to `transportEmail` for the Resend provider.
 *
 * No path in here ever sends more than one recipient: the request cannot
 * describe more than one recipient, and the recipient is always the single
 * email persisted on the prospect's verified contact record.
 */
export async function sendControlledEmail(
  input: ControlledSendInput,
): Promise<ControlledSendResult> {
  const { prospectId, draftId } = input;

  // --- explicit confirmation (a POST mutation must say yes) ----------------
  if (input.confirm !== true) {
    throw blocked(
      "CONFIRM_REQUIRED",
      400,
      "Explicit confirmation (confirm: true) is required to send one email.",
    );
  }

  // --- prospect + draft (server-resolved only) -----------------------------
  const lead = getLeadById(prospectId);
  if (!lead) {
    throw blocked("PROSPECT_NOT_FOUND", 404, "Prospect not found.");
  }

  const draft = getOutreachDraft(draftId);
  if (!draft) {
    throw blocked("DRAFT_NOT_FOUND", 404, "Draft not found.");
  }
  if (draft.leadId !== prospectId) {
    throw blocked(
      "DRAFT_LEAD_MISMATCH",
      422,
      "Draft does not belong to this prospect.",
    );
  }

  // --- recipient: ONLY from the persisted verified contact -----------------
  const contact = lead.contactDiscovery;
  const recipientEmail =
    contact?.emailStatus === "found" &&
    (contact.emailConfidence === "high" || contact.emailConfidence === "medium") &&
    contact.email
      ? normalizeRecipientEmail(contact.email)
      : null;
  if (!recipientEmail) {
    throw blocked(
      "RECIPIENT_NOT_VERIFIED",
      422,
      "Prospect has no verified contact email; nothing can be sent.",
    );
  }

  // --- campaign context -----------------------------------------------------
  const campaignId =
    lead.campaignId ?? listCampaignIdsByLeadId(prospectId)[0] ?? null;
  const campaign = campaignId ? getCampaign(campaignId) : null;
  if (!campaignId || !campaign) {
    throw blocked("NO_CAMPAIGN", 409, "No campaign is associated with this prospect.");
  }
  if (mapCampaignRunState(campaign.status) !== "running") {
    throw blocked(
      "CAMPAIGN_NOT_RUNNING",
      409,
      `Campaign is "${campaign.status}"; it must be running to send.`,
    );
  }

  // --- Agent 8 (outreach send safety), side-effect free ---------------------
  const agent8 = evaluateSendSafety(
    { leadId: prospectId, draftId, recipientEmail },
    { recordAuthorization: false },
  );
  if (agent8.decision !== "SEND") {
    throw blocked(
      "AGENT8_NOT_SEND",
      422,
      agent8.reason,
    );
  }

  // --- Agent 10 (transport safety) — read from env by default --------------
  const agent10 = evaluateTransportSafety({
    leadId: prospectId,
    draftId,
    recipientEmail,
    campaignId,
    agent8Decision: "SEND",
    provider: "resend",
  });
  if (agent10.decision !== "TRANSPORT_READY") {
    if (agent10.code === "PROVIDER_NOT_CONFIGURED") {
      throw blocked(
        "RESEND_NOT_CONFIGURED",
        409,
        agent10.reason,
      );
    }
    throw blocked("AGENT10_NOT_READY", 422, agent10.reason);
  }

  // --- server-built transport request (nothing client-supplied) -------------
  const currentVersionId = agent10.website.currentVersionId;
  if (!currentVersionId) {
    throw blocked(
      "AGENT10_NOT_READY",
      422,
      "Agent 10 reported no current website version; transport fails closed.",
    );
  }

  const idempotencyKey = buildIdempotencyKey({
    leadId: prospectId,
    draftId,
    recipientEmail,
    draftHash: draft.contentHash,
  });

  const outcome = await transportEmail({
    agent10Result: agent10,
    campaignId,
    prospectId,
    recipientEmail,
    draftId,
    contentHash: draft.contentHash,
    websiteVersionId: currentVersionId,
    subject: draft.subject ?? "",
    body: draft.body,
    idempotencyKey,
    providerId: "resend",
    deploymentUrl: agent10.website.deploymentUrl,
  });

  return { status: outcome.status === "sent" ? "sent" : "duplicate", outcome };
}

// re-export for route error handling
export { EmailTransportError };