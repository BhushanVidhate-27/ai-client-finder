/**
 * Outreach Send Safety (Agent 8) — deterministic send-intent evaluation.
 *
 * This module NEVER sends email. It answers a single question: "Is this exact
 * outreach draft safe and authorized to be sent?" The final decision is fully
 * deterministic and is derived entirely from trusted application state:
 *
 *   - persisted campaign/lead/draft/approval/opt-out/send records
 *   - verified contact discovery for the prospect
 *   - verified deployment state for the current website version
 *
 * Untrusted content (draft copy, replies, research notes, website copy, etc.)
 * is only ever allowed to BLOCK, never to authorize. A SEND evaluation is the
 * only writer of a send-authorization row, so every decision here is durable,
 * idempotent and replay-safe.
 */

import { getLeadById } from "@/lib/data/leads";
import { getCampaign, listCampaignIdsByLeadId } from "@/lib/data/campaigns";
import { getResearchByLeadId } from "@/lib/data/research";
import { getCurrentWebsiteVersion } from "@/lib/data/websites";
import { listDeploymentRecordsByLead } from "@/lib/data/deployments";
import {
  getOutreachDraft,
  getValidOutreachApproval,
  getOutreachOptOut,
  getOutreachSendByBinding,
  hasPriorSend,
  buildIdempotencyKey,
  recordSendAuthorization,
  isUniqueViolationError,
} from "@/lib/data/outreach";
import { isBlockedHostname, isSafeUrlScheme } from "@/lib/url-safety";
import {
  detectOptOutSignal,
  scanDraftContent,
  LIVE_SITE_CLAIM_PATTERN,
} from "@/lib/outreach-safety/content-safety";
import type {
  CampaignRunState,
  OutreachApprovalStatus,
  OutreachCheck,
  OutreachDecision,
  OutreachSafetyResult,
  SafetyEvaluationInput,
  SafetyEvaluationOptions,
} from "@/lib/outreach-safety/types";

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

const EMAIL_FORMAT = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/;

export function normalizeRecipientEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidRecipientEmail(email: string): boolean {
  return EMAIL_FORMAT.test(email) && email.length <= 254;
}

/**
 * Maps the free-form campaign status to a deterministic run state.
 * Campaign statuses are plain strings across the app; anything that mentions
 * pausing means paused, anything that mentions stopping/halting/cancelling
 * means stopped, everything else is treated as running.
 */
export function mapCampaignRunState(status: string): CampaignRunState {
  if (/stop|halt|cancel/i.test(status)) return "stopped";
  if (/paus/i.test(status)) return "paused";
  return "running";
}

function defaultTransportAvailable(): boolean {
  const value = process.env.EMAIL_TRANSPORT_CONFIGURED ?? "";
  return value === "1" || value.toLowerCase() === "true";
}

// ---------------------------------------------------------------------------
// Main evaluation
// ---------------------------------------------------------------------------

export function evaluateSendSafety(
  input: SafetyEvaluationInput,
  options: SafetyEvaluationOptions = {},
): OutreachSafetyResult {
  const checks: OutreachCheck[] = [];
  const blockingIssues: string[] = [];
  const leadId = input.leadId;

  const lead = getLeadById(leadId);
  const draft = getOutreachDraft(input.draftId);
  const recipient = input.recipientEmail
    ? normalizeRecipientEmail(input.recipientEmail)
    : "";

  const idempotencyKey =
    draft && recipient
      ? buildIdempotencyKey({
          leadId,
          draftId: draft.id,
          recipientEmail: recipient,
          draftHash: draft.contentHash,
        })
      : "";

  const alreadyProcessed =
    draft && recipient
      ? getOutreachSendByBinding({
          leadId,
          draftId: draft.id,
          recipientEmail: recipient,
          draftHash: draft.contentHash,
        }) !== null
      : false;

  const buildResult = (
    decision: OutreachDecision,
    reason: string,
    approval: Omit<OutreachApprovalStatus, "required">,
    detail?: string,
  ): OutreachSafetyResult => {
    blockingIssues.push(reason);
    return {
      decision,
      eligibleToSend: false,
      reason: detail ? `${reason} ${detail}` : reason,
      prospectId: leadId,
      draftId: draft ? draft.id : input.draftId,
      recipient: { email: recipient },
      approval: { required: true, ...approval },
      blockingIssues,
      checks,
      idempotency: { key: idempotencyKey, alreadyProcessed },
      execute: false,
    };
  };

  // --- stop requested -------------------------------------------------------
  const stopRequested = options.stopRequested === true;
  checks.push({
    id: "stop_requested",
    label: "Run has not been stopped",
    passed: !stopRequested,
    detail: stopRequested ? "The job controller requested a stop." : undefined,
  });
  if (stopRequested) {
    return buildResult(
      "WAIT",
      "Stop was requested; the send is paused and will be re-evaluated.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }

  // --- opt-out (recorded and/or signalled in untrusted reply text) ----------
  const recordedOptOut = lead ? getOutreachOptOut(leadId) : null;
  const replyOptOut = input.replyText ? detectOptOutSignal(input.replyText) : [];
  const optOutSignalled = Boolean(recordedOptOut || replyOptOut.length > 0);
  checks.push({
    id: "opt_out",
    label: "No opt-out or unsubscribe signal",
    passed: !optOutSignalled,
    detail: optOutSignalled
      ? [
          recordedOptOut ? `Recorded opt-out: ${recordedOptOut.signal}` : null,
          replyOptOut.map((f) => f.message).join(" ") || null,
        ]
          .filter(Boolean)
          .join(" ")
      : undefined,
  });
  if (optOutSignalled) {
    return buildResult(
      "SKIP_PROSPECT",
      "Prospect has opted out of contact.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }

  // --- campaign run state ---------------------------------------------------
  let campaignId: string | null = null;
  if (lead) {
    campaignId = lead.campaignId ?? listCampaignIdsByLeadId(leadId)[0] ?? null;
  }
  const campaign = campaignId ? getCampaign(campaignId) : null;
  const runState = campaign ? mapCampaignRunState(campaign.status) : null;
  const niche = campaign?.niche ?? null;

  checks.push({
    id: "campaign",
    label: "Campaign state permits outreach",
    passed: campaign !== null && runState === "running",
    detail: campaign
      ? `Campaign status is "${campaign.status}".`
      : "No campaign is associated with this prospect.",
  });

  if (!campaign) {
    return buildResult(
      "WAIT",
      "No campaign is associated with this prospect; outreach cannot be evaluated.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }
  if (runState === "stopped") {
    return buildResult(
      "REJECT",
      "Campaign is stopped; outreach is not permitted.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }
  if (runState === "paused") {
    return buildResult(
      "WAIT",
      "Campaign is paused; outreach is waiting and will be re-evaluated.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }

  // --- prospect -------------------------------------------------------------
  const qualified = Boolean(lead?.qualification?.qualified === true);
  checks.push({
    id: "lead",
    label: "Prospect exists and is qualified",
    passed: lead !== null && qualified,
    detail: !lead ? "Prospect not found." : !qualified ? "Prospect is not qualified." : undefined,
  });
  if (!lead || !qualified) {
    return buildResult(
      "REJECT",
      !lead ? "Prospect not found." : "Prospect is not qualified for outreach.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }

  // --- recipient ------------------------------------------------------------
  const recipientValid = recipient
    ? isValidRecipientEmail(recipient)
    : false;
  checks.push({
    id: "recipient",
    label: "Recipient email is present and well-formed",
    passed: recipientValid,
    detail: !recipient ? "No recipient email." : !recipientValid ? "Invalid email format." : undefined,
  });
  if (!recipientValid) {
    return buildResult(
      "REJECT",
      "Recipient email is missing or invalid.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }

  const contact = lead.contactDiscovery;
  const verifiedEmail =
    contact?.email !== null &&
    contact?.emailStatus === "found" &&
    (contact.emailConfidence === "high" || contact.emailConfidence === "medium") &&
    contact.email
      ? normalizeRecipientEmail(contact.email) === recipient
      : false;
  checks.push({
    id: "recipient_verified",
    label: "Recipient matches a verified contact email",
    passed: verifiedEmail,
    detail: verifiedEmail
      ? undefined
      : `Stored email status: ${contact?.emailStatus ?? "none"}.`,
  });
  if (!verifiedEmail) {
    return buildResult(
      "REJECT",
      "Recipient email is not verified for this prospect.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }

  // --- draft ----------------------------------------------------------------
  checks.push({
    id: "draft",
    label: "Draft exists and belongs to this prospect",
    passed: draft !== null && draft.leadId === leadId,
    detail: !draft ? "Draft not found." : draft.leadId !== leadId ? "Draft belongs to a different prospect." : undefined,
  });
  if (!draft || draft.leadId !== leadId) {
    return buildResult(
      "REJECT",
      !draft ? "Draft not found." : "Draft does not belong to this prospect.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }

  checks.push({
    id: "draft_eligible",
    label: "Draft is marked eligible",
    passed: draft.status === "eligible",
    detail: `Draft status is "${draft.status}".`,
  });
  if (draft.status !== "eligible") {
    return buildResult(
      "REJECT",
      "Draft is not eligible; only eligible drafts may be authorized.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }

  checks.push({
    id: "draft_hash",
    label: "Draft has a recorded server-side hash",
    passed: Boolean(draft.contentHash),
  });
  if (!draft.contentHash) {
    return buildResult(
      "REJECT",
      "Draft has no recorded content hash; it cannot be authorized.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }

  // --- website / deployment claims ------------------------------------------
  // Compute verification BEFORE content safety: a live-site claim that is
  // proven by deployment DB state must suppress the "claim-fake-hosting" rule.
  const claimsLiveSite = LIVE_SITE_CLAIM_PATTERN.test(
    `${draft.subject ?? ""}\n${draft.body}`,
  );
  const currentVersion = getCurrentWebsiteVersion(leadId);
  const readyDeployment = listDeploymentRecordsByLead(leadId).filter(
    (d) => d.status === "ready" && d.deploymentUrl !== null,
  )[0] ?? null;

  const verifiedUrl = readyDeployment?.deploymentUrl ?? null;
  let safeDraftUrl = false;
  if (draft.websiteUrl && isSafeUrlScheme(draft.websiteUrl)) {
    try {
      safeDraftUrl = !isBlockedHostname(new URL(draft.websiteUrl).hostname);
    } catch {
      safeDraftUrl = false;
    }
  }

  const websiteClaimPasses =
    !claimsLiveSite ||
    (verifiedUrl !== null &&
      Boolean(currentVersion) &&
      readyDeployment !== null &&
      Boolean(readyDeployment.websiteVersionId) &&
      currentVersion !== null &&
      readyDeployment.websiteVersionId === currentVersion.projectId &&
      draft.websiteUrl === verifiedUrl &&
      safeDraftUrl);

  // --- content safety (untrusted copy can only block) -----------------------
  const research = getResearchByLeadId(leadId);
  const verifiedServices =
    options.verifiedServices ?? research?.websiteResearch?.services ?? [];
  const contentFindings = scanDraftContent(
    { subject: draft.subject, body: draft.body },
    { verifiedServices, niche: niche ?? undefined },
  ).filter((finding) => !(finding.ruleId === "claim-fake-hosting" && websiteClaimPasses));
  checks.push({
    id: "content_safety",
    label: "Draft copy passed deterministic safety review",
    passed: contentFindings.length === 0,
    detail: contentFindings.length > 0
      ? contentFindings.map((f) => f.message).join(" ")
      : undefined,
  });
  if (contentFindings.length > 0) {
    blockingIssues.push(...contentFindings.map((f) => f.message));
    return buildResult(
      "REJECT",
      "Draft copy failed deterministic safety review.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }

  checks.push({
    id: "website_claim",
    label: "Live-site claim is backed by a verified deployment",
    passed: websiteClaimPasses,
    detail: websiteClaimPasses
      ? undefined
      : claimsLiveSite
        ? "Draft claims the site is live but the deployment is not verified."
        : undefined,
  });
  if (!websiteClaimPasses) {
    blockingIssues.push(
      "The draft's live-site claim is not verified by deployment state.",
    );
    return buildResult(
      "REJECT",
      "Draft makes a website claim that is not verified by deployment state.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }

  // Stale website version: an authorized send must reference the current version.
  const versionStale =
    Boolean(draft.websiteVersionId) &&
    Boolean(currentVersion) &&
    currentVersion !== null &&
    draft.websiteVersionId !== null &&
    draft.websiteVersionId !== currentVersion.projectId;
  const claimWithoutVersion =
    claimsLiveSite && !draft.websiteVersionId;
  checks.push({
    id: "website_version",
    label: "Draft references the current website version",
    passed: !versionStale && !claimWithoutVersion,
    detail: versionStale
      ? "Draft version differs from the current version."
      : claimWithoutVersion
        ? "Draft omits the website version but claims the site is live."
        : undefined,
  });
  if (versionStale || claimWithoutVersion) {
    return buildResult(
      "REJECT",
      versionStale
        ? "Draft references a stale website version; re-approval is required."
        : "Draft omits the website version but claims the site is live.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
    );
  }

  // --- duplicate protection / idempotency -----------------------------------
  const dupCheck: OutreachCheck = {
    id: "duplicate",
    label: "This exact outreach was not already processed",
    passed: !alreadyProcessed,
    detail: alreadyProcessed
      ? "A send authorization already exists for this exact outreach."
      : undefined,
  };
  checks.push(dupCheck);
  if (alreadyProcessed || hasPriorSend({
    leadId,
    draftId: draft.id,
    recipientEmail: recipient,
    draftHash: draft.contentHash,
  })) {
    blockingIssues.push(
      "This exact outreach (prospect, draft, recipient, hash) was already processed.",
    );
    return buildResult(
      "REJECT",
      "This exact outreach was already authorized; duplicate sends are blocked.",
      { valid: false, boundToDraft: false, boundToRecipient: false, boundToProspect: false },
      "duplicate idempotency key.",
    );
  }

  // --- approval binding ------------------------------------------------------
  const approval = getValidOutreachApproval(draft.id);
  const approvalValid =
    approval !== null &&
    approval.status === "valid" &&
    Boolean(approval.createdBy) &&
    Boolean(approval.createdAt) &&
    (approval.expiresAt === null ||
      approval.expiresAt === "" ||
      new Date(approval.expiresAt).getTime() > Date.now());
  const boundToDraft =
    approvalValid &&
    approval.draftId === draft.id &&
    approval.draftHash === draft.contentHash;
  const boundToRecipient =
    approvalValid && approval.recipientEmail === recipient;
  const boundToProspect = approvalValid && approval.leadId === leadId;
  const approvalBound = boundToDraft && boundToRecipient && boundToProspect;

  checks.push({
    id: "approval",
    label: "Human approval is bound to this exact outreach",
    passed: approvalValid && approvalBound,
    detail: !approvalValid
      ? approval
        ? approval.status !== "valid"
          ? `Approval status is "${approval.status}".`
          : !approval.createdBy
            ? "Approval has no recorded author identity."
            : !approval.createdAt
              ? "Approval has no recorded timestamp."
              : "Approval is expired."
        : "No human approval exists."
      : !boundToDraft
        ? "Approval is not bound to this exact draft content."
        : !boundToRecipient
          ? "Approval is not bound to this recipient."
          : "Approval is not bound to this prospect.",
  });

  if (!approvalValid || !approvalBound) {
    blockingIssues.push(
      "No valid human approval is bound to this exact outreach.",
    );
    return buildResult(
      "WAIT_FOR_APPROVAL",
      "Awaiting human approval bound to this exact outreach.",
      { valid: false, boundToDraft, boundToRecipient, boundToProspect },
    );
  }

  // --- transport -------------------------------------------------------------
  const transportAvailable =
    options.transportAvailable ?? defaultTransportAvailable();
  checks.push({
    id: "transport",
    label: "Email transport is configured",
    passed: transportAvailable,
    detail: transportAvailable
      ? undefined
      : "No transport is configured (EMAIL_TRANSPORT_CONFIGURED is unset).",
  });
  if (!transportAvailable) {
    blockingIssues.push(
      "Email transport is not configured; nothing will be sent.",
    );
    return buildResult(
      "WAIT",
      "Email transport is not configured; the send is waiting.",
      { valid: true, boundToDraft, boundToRecipient, boundToProspect },
    );
  }

  // --- SEND (intent only; never actually sends) ------------------------------
  try {
    if (options.recordAuthorization !== false) {
      recordSendAuthorization({
        leadId,
        draftId: draft.id,
        recipientEmail: recipient,
        draftHash: draft.contentHash,
        idempotencyKey,
        decision: "SEND",
        status: "authorized",
        websiteVersionId: draft.websiteVersionId,
        deploymentUrl: draft.websiteUrl,
      });
    }
  } catch (error) {
    if (isUniqueViolationError(error)) {
      blockingIssues.push("This exact outreach was already processed.");
      checks.push({
        id: "duplicate",
        label: "This exact outreach was not already processed",
        passed: false,
        detail: "A concurrent authorization for the same outreach succeeded first.",
      });
      return buildResult(
        "REJECT",
        "This exact outreach was already authorized; duplicate sends are blocked.",
        { valid: true, boundToDraft, boundToRecipient, boundToProspect },
        "duplicate idempotency key.",
      );
    }
    throw error;
  }

  return {
    decision: "SEND",
    eligibleToSend: true,
    reason:
      "All safety gates passed and a human approval is bound to this exact outreach. " +
      "This is an intent only — nothing was sent.",
    prospectId: leadId,
    draftId: draft.id,
    recipient: { email: recipient },
    approval: {
      required: true,
      valid: true,
      boundToDraft,
      boundToRecipient,
      boundToProspect,
    },
    blockingIssues,
    checks: [
      ...checks,
      {
        id: "authorized",
        label: "Send authorization recorded",
        passed: true,
        detail: "Authorization persisted; execute remains false.",
      },
    ],
    idempotency: { key: idempotencyKey, alreadyProcessed: false },
    execute: false,
  };
}