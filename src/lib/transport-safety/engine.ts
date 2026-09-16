/**
 * Transport Safety (Agent 10) — deterministic pre-transport gate.
 *
 * This engine decides whether the exact outreach for a prospect may be marked
 * READY_FOR_TRANSPORT (intent only — nothing is ever sent here). It is a pure
 * reader of trusted application state and never performs side effects:
 *
 * - no writes, no DB mutations, no send-authorization rows
 * - no email provider, no SMTP, no fetch/network, no shell, no deployment
 * - no Gemini/LLM calls; untrusted text can only block, never authorize
 * - `execute` is always `false`
 *
 * Every safety check is cheaper/safer to fail than to pass; TRANSPORT_READY is
 * returned only when every gate passes, with the provider/configuration check
 * evaluated LAST so configuration can never override a safety decision.
 */

import { getCampaign, listCampaignIdsByLeadId } from "@/lib/data/campaigns";
import { getLeadById } from "@/lib/data/leads";
import { getCurrentWebsiteVersion } from "@/lib/data/websites";
import {
  isActiveDeploymentStatus,
  listDeploymentRecordsByLead,
} from "@/lib/data/deployments";
import { getValidDeploymentApproval, listDeploymentApprovalsByLead } from "@/lib/data/deployment-approvals";
import {
  buildIdempotencyKey,
  getOutreachApprovalByDraft,
  getOutreachDraft,
  getOutreachOptOut,
  getOutreachSendByBinding,
  hashOutreachDraft,
} from "@/lib/data/outreach";
import { detectOptOutSignal } from "@/lib/outreach-safety/content-safety";
import {
  mapCampaignRunState,
  normalizeRecipientEmail,
  isValidRecipientEmail,
} from "@/lib/outreach-safety/safety";
import {
  SUPPORTED_TRANSPORT_PROVIDERS,
  type TransportCheck,
  type TransportDecision,
  type TransportResult,
  type TransportSafetyInput,
  type TransportSafetyOptions,
} from "@/lib/transport-safety/types";

function defaultEnvProvider(): string | null {
  const value = process.env.EMAIL_TRANSPORT_PROVIDER ?? "";
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function defaultEnvConfigured(): boolean {
  const value = process.env.EMAIL_TRANSPORT_CONFIGURED ?? "";
  return value === "1" || value.toLowerCase() === "true";
}

/**
 * Maps an Agent 10 decision to the campaign state machine (mirrors
 * `mapOutreachDecision` for Agent 8). TRANSPORT_READY is the only state that
 * ever maps to READY_FOR_TRANSPORT; everything else is a wait, skip or fail.
 */
export function mapTransportDecision(
  decision: unknown,
): "READY_FOR_TRANSPORT" | "WAIT" | "SKIP_PROSPECT" {
  switch (decision) {
    case "TRANSPORT_READY":
      return "READY_FOR_TRANSPORT";
    case "WAIT":
      return "WAIT";
    case "REJECT":
      return "SKIP_PROSPECT";
    case "SKIP_PROSPECT":
      return "SKIP_PROSPECT";
    default:
      return "SKIP_PROSPECT";
  }
}

export function evaluateTransportSafety(
  input: TransportSafetyInput,
  options: TransportSafetyOptions = {},
): TransportResult {
  const leadId = input.leadId;
  const checks: TransportCheck[] = [];
  const blockingIssues: string[] = [];

  const providerId = input.provider
    ? normalizeRecipientEmail(input.provider)
    : defaultEnvProvider();

  const recipientInput = input.recipientEmail
    ? normalizeRecipientEmail(input.recipientEmail)
    : "";
  const draft = input.draftId ? getOutreachDraft(input.draftId) : null;
  const lead = getLeadById(leadId);

  const idempotencyKey =
    draft && recipientInput
      ? buildIdempotencyKey({
          leadId,
          draftId: draft.id,
          recipientEmail: recipientInput,
          draftHash: draft.contentHash,
        })
      : "";

  const alreadyProcessed =
    draft && recipientInput
      ? getOutreachSendByBinding({
          leadId,
          draftId: draft.id,
          recipientEmail: recipientInput,
          draftHash: draft.contentHash,
        }) !== null
      : false;

  const pass = (check: TransportCheck) => {
    checks.push(check);
    return check.passed;
  };

  const buildResult = (
    decision: TransportDecision,
    code: string,
    reason: string,
    extra?: { approval?: TransportResult["approval"]; blockingIssue?: string },
  ): TransportResult => {
    const issue = extra?.blockingIssue ?? reason;
    if (!blockingIssues.includes(issue)) blockingIssues.push(issue);
    return {
      decision,
      code,
      reason,
      prospectId: leadId,
      draftId: draft ? draft.id : input.draftId ?? null,
      campaignId: null,
      recipient: { email: recipientInput },
      approval: extra?.approval ?? {
        required: true,
        valid: false,
        boundToDraft: false,
        boundToRecipient: false,
        boundToProspect: false,
      },
      agent8: { decision: input.agent8Decision ?? null },
      provider: {
        id: providerId,
        supported: providerId
          ? (SUPPORTED_TRANSPORT_PROVIDERS as readonly string[]).includes(
              providerId,
            )
          : false,
        configured: false,
      },
      website: {
        currentVersionId: null,
        deploymentUrl: null,
        deploymentStatus: null,
        ready: false,
      },
      duplicate: { key: idempotencyKey, alreadyProcessed },
      blockingIssues,
      checks: [...checks],
      execute: false,
    };
  };

  // --- stop requested (overrides everything) --------------------------------
  const stopRequested = options.stopRequested === true;
  pass({
    id: "stop_requested",
    label: "Run has not been stopped",
    passed: !stopRequested,
    detail: stopRequested ? "The job controller requested a stop." : undefined,
  });
  if (stopRequested) {
    return buildResult(
      "REJECT",
      "STOP_REQUESTED",
      "A stop was requested; transport is not permitted.",
    );
  }

  // --- prospect -------------------------------------------------------------
  const qualified =
    lead !== null &&
    lead.qualification?.qualificationStatus === "complete" &&
    lead.qualification?.qualified === true &&
    (lead.qualification.websiteOpportunity === "NO_WEBSITE" ||
      lead.qualification.websiteOpportunity === "NEEDS_REDESIGN");
  pass({
    id: "lead",
    label: "Prospect exists and is eligible for outreach",
    passed: lead !== null && qualified,
    detail: !lead
      ? "Prospect not found."
      : !qualified
        ? "Prospect is not eligible for outreach."
        : undefined,
  });
  if (!lead) {
    return buildResult(
      "REJECT",
      "PROSPECT_MISSING",
      "Prospect not found; transport cannot be evaluated.",
    );
  }
  if (!qualified) {
    return buildResult(
      "REJECT",
      "PROSPECT_INELIGIBLE",
      "Prospect is not eligible for outreach.",
    );
  }

  // --- opt-out (only blocks) ------------------------------------------------
  const recordedOptOut = getOutreachOptOut(leadId);
  const replyOptOut = input.replyText ? detectOptOutSignal(input.replyText) : [];
  const optOut = Boolean(recordedOptOut || replyOptOut.length > 0);
  pass({
    id: "opt_out",
    label: "No opt-out or unsubscribe signal",
    passed: !optOut,
    detail: optOut
      ? [
          recordedOptOut ? `Recorded opt-out: ${recordedOptOut.signal}` : null,
          replyOptOut.map((f) => f.message).join(" ") || null,
        ]
          .filter(Boolean)
          .join(" ")
      : undefined,
  });
  if (optOut) {
    return buildResult(
      "SKIP_PROSPECT",
      "OPT_OUT",
      "The prospect opted out of contact; transport is not permitted.",
    );
  }

  // --- campaign (stopped before all readiness; paused prevents READY) -------
  const leadCampaignId =
    lead.campaignId ?? listCampaignIdsByLeadId(leadId)[0] ?? null;
  if (input.campaignId && leadCampaignId && input.campaignId !== leadCampaignId) {
    return buildResult(
      "REJECT",
      "CAMPAIGN_MISMATCH",
      "The evaluation campaign differs from this prospect's campaign.",
    );
  }
  const campaignId = input.campaignId ?? leadCampaignId;
  const campaign = campaignId ? getCampaign(campaignId) : null;
  const runState = campaign ? mapCampaignRunState(campaign.status) : null;
  pass({
    id: "campaign",
    label: "Campaign exists and is running",
    passed: campaign !== null && runState === "running",
    detail: campaign
      ? `Campaign status is "${campaign.status}".`
      : "No campaign is associated with this prospect.",
  });
  if (!campaign) {
    return buildResult(
      "WAIT",
      "CAMPAIGN_MISSING",
      "No campaign is associated with this prospect; transport cannot be evaluated.",
    );
  }
  if (runState === "stopped") {
    return buildResult(
      "REJECT",
      "CAMPAIGN_STOPPED",
      "Campaign is stopped; transport is not permitted.",
    );
  }
  if (runState === "paused") {
    return buildResult(
      "WAIT",
      "CAMPAIGN_PAUSED",
      "Campaign is paused; transport is waiting and will be re-evaluated.",
    );
  }

  // --- recipient ------------------------------------------------------------
  const recipientValid = recipientInput
    ? isValidRecipientEmail(recipientInput)
    : false;
  pass({
    id: "recipient",
    label: "Recipient email is present and well-formed",
    passed: recipientValid,
    detail: !recipientInput
      ? "No recipient email."
      : !recipientValid
        ? "Invalid email format."
        : undefined,
  });
  if (!recipientValid) {
    return buildResult(
      "REJECT",
      !recipientInput ? "RECIPIENT_MISSING" : "RECIPIENT_INVALID",
      !recipientInput
        ? "Recipient email is missing."
        : "Recipient email is invalid.",
    );
  }

  const contact = lead.contactDiscovery;
  const verifiedEmail =
    contact?.email !== null &&
    contact?.emailStatus === "found" &&
    (contact.emailConfidence === "high" || contact.emailConfidence === "medium") &&
    contact.email
      ? normalizeRecipientEmail(contact.email) === recipientInput
      : false;
  pass({
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
      "RECIPIENT_UNVERIFIED",
      "Recipient email is not verified for this prospect.",
    );
  }

  // --- draft ----------------------------------------------------------------
  pass({
    id: "draft",
    label: "Draft exists and belongs to this prospect",
    passed: draft !== null && draft.leadId === leadId,
    detail: !draft
      ? "Draft not found."
      : draft.leadId !== leadId
        ? "Draft belongs to a different prospect."
        : undefined,
  });
  if (!draft) {
    return buildResult(
      "REJECT",
      "DRAFT_MISSING",
      "Draft not found.",
    );
  }
  if (draft.leadId !== leadId) {
    return buildResult(
      "REJECT",
      "DRAFT_OTHER_PROSPECT",
      "Draft does not belong to this prospect.",
    );
  }
  pass({
    id: "draft_eligible",
    label: "Draft is marked eligible",
    passed: draft.status === "eligible",
    detail: `Draft status is "${draft.status}".`,
  });
  if (draft.status !== "eligible") {
    return buildResult(
      "REJECT",
      "DRAFT_NOT_ELIGIBLE",
      "Draft is not eligible; only eligible drafts may be transported.",
    );
  }
  const recomputedHash = hashOutreachDraft(draft.subject, draft.body);
  pass({
    id: "draft_content_hash",
    label: "Draft content matches its recorded server-side hash",
    passed: Boolean(draft.contentHash) && recomputedHash === draft.contentHash,
    detail:
      !draft.contentHash
        ? "Draft has no recorded content hash."
        : recomputedHash !== draft.contentHash
          ? "Draft content no longer matches its recorded hash."
          : undefined,
  });
  if (!draft.contentHash || recomputedHash !== draft.contentHash) {
    return buildResult(
      "REJECT",
      "DRAFT_TAMPERED_HASH",
      "Draft content does not match its recorded hash; transport is blocked.",
    );
  }

  // --- Agent 8 decision (trusted input; never self-derived) -----------------
  const agent8Empty =
    !input.agent8Decision || String(input.agent8Decision).trim() === "";
  let agent8Blocked: TransportResult | null = null;
  switch (String(input.agent8Decision ?? "").trim()) {
    case "SEND":
      break;
    case "WAIT":
    case "WAIT_FOR_APPROVAL":
      agent8Blocked = buildResult(
        "WAIT",
        "AGENT8_WAITING",
        "Agent 8 did not authorize a send; transport is waiting.",
      );
      break;
    case "REJECT":
      agent8Blocked = buildResult(
        "REJECT",
        "AGENT8_REJECTED",
        "Agent 8 rejected the outreach; transport is not permitted.",
      );
      break;
    case "SKIP_PROSPECT":
      agent8Blocked = buildResult(
        "SKIP_PROSPECT",
        "AGENT8_SKIPPED",
        "Agent 8 skipped this prospect; transport is not permitted.",
      );
      break;
    default:
      agent8Blocked = buildResult(
        "REJECT",
        "AGENT8_UNKNOWN",
        agent8Empty
          ? "No Agent 8 decision was provided; transport fails closed."
          : `Agent 8 decision "${input.agent8Decision}" is unknown; transport fails closed.`,
      );
      break;
  }
  pass({
    id: "agent8_decision",
    label: "Agent 8 explicitly authorized SEND",
    passed: agent8Blocked === null,
    detail:
      agent8Blocked === null
        ? undefined
        : `Agent 8 decision: "${input.agent8Decision ?? "none"}".`,
  });
  if (agent8Blocked) return agent8Blocked;

  // --- duplicate / idempotency ---------------------------------------------
  pass({
    id: "duplicate",
    label: "This exact outreach was not already processed",
    passed: !alreadyProcessed,
    detail: alreadyProcessed
      ? "A send authorization already exists for this exact outreach."
      : undefined,
  });
  if (alreadyProcessed) {
    return buildResult(
      "REJECT",
      "DUPLICATE_TRANSPORT",
      "This exact outreach was already authorized; duplicate transport is blocked.",
      { blockingIssue: "This exact outreach was already processed." },
    );
  }

  // --- website version / deployment validity -------------------------------
  const currentVersion = getCurrentWebsiteVersion(leadId);
  pass({
    id: "website_version",
    label: "Current website version exists",
    passed: currentVersion !== null,
  });
  if (!currentVersion) {
    return buildResult(
      "WAIT",
      "VERSION_MISSING",
      "No current website version exists; transport is waiting.",
    );
  }

  const deployments = listDeploymentRecordsByLead(leadId);
  const readyDeployment =
    deployments.find(
      (d) =>
        d.status === "ready" &&
        d.deploymentUrl !== null &&
        d.websiteVersionId === currentVersion.projectId,
    ) ?? null;
  const deploymentActive = deployments.find((d) =>
    isActiveDeploymentStatus(d.status),
  );
  pass({
    id: "deployment",
    label: "Current version is deployed and live",
    passed: readyDeployment !== null,
    detail: readyDeployment
      ? `Deployed at ${readyDeployment.deploymentUrl}.`
      : deploymentActive
        ? `A deployment is in progress (${deploymentActive.status}).`
        : "No ready deployment exists for the current version.",
  });
  if (!readyDeployment) {
    if (deploymentActive) {
      return buildResult(
        "WAIT",
        "DEPLOYMENT_IN_PROGRESS",
        "A deployment is in progress; transport is waiting.",
      );
    }
    return buildResult(
      "REJECT",
      "DEPLOYMENT_NOT_READY",
      "The current version has no verified live deployment; transport is blocked.",
    );
  }

  const depApprovalRow = listDeploymentApprovalsByLead(leadId).find(
    (a) => a.websiteVersionId === currentVersion.projectId,
  ) ?? null;
  const depApproval = getValidDeploymentApproval(currentVersion.projectId);
  const depApprovalNotExpired =
    depApprovalRow !== null &&
    (depApprovalRow.expiresAt === null ||
      depApprovalRow.expiresAt === "" ||
      new Date(depApprovalRow.expiresAt).getTime() > Date.now());
  const depApprovalValid =
    depApproval !== null &&
    depApproval.status === "valid" &&
    Boolean(depApproval.createdBy) &&
    Boolean(depApproval.createdAt) &&
    depApprovalNotExpired;
  const depApprovalBound =
    depApprovalValid &&
    depApproval.websiteVersionId === currentVersion.projectId &&
    depApproval.artifactHash === currentVersion.artifactHash &&
    Boolean(readyDeployment.artifactHash);
  pass({
    id: "deployment_approval",
    label: "Human approval is bound to the exact current version and artifact hash",
    passed: depApprovalBound,
    detail: !depApprovalRow
      ? "No human deployment approval exists."
      : depApprovalRow.status !== "valid"
        ? `Deployment approval status is "${depApprovalRow.status}".`
        : !depApprovalNotExpired
          ? "Deployment approval is expired."
          : "Deployment approval is not bound to the exact current version and artifact hash.",
  });
  if (!depApprovalBound) {
    if (depApprovalRow && depApprovalRow.status === "revoked") {
      return buildResult(
        "REJECT",
        "DEPLOYMENT_APPROVAL_REVOKED",
        "The deployment approval was revoked; transport is blocked.",
      );
    }
    if (depApprovalRow && !depApprovalNotExpired) {
      return buildResult(
        "WAIT",
        "DEPLOYMENT_APPROVAL_EXPIRED",
        "The deployment approval is expired; waiting for re-approval.",
      );
    }
    return buildResult(
      "WAIT",
      "DEPLOYMENT_APPROVAL_MISSING",
      "Awaiting a human deployment approval bound to the exact current version and artifact hash.",
    );
  }

  // --- outreach approval (exact binding) ------------------------------------
  const approval = draft.id ? getOutreachApprovalByDraft(draft.id) : null;
  const approvalNotExpired =
    approval !== null &&
    (approval.expiresAt === null ||
      approval.expiresAt === "" ||
      new Date(approval.expiresAt).getTime() > Date.now());
  const approvalValid =
    approval !== null &&
    approval.status === "valid" &&
    Boolean(approval.createdBy) &&
    Boolean(approval.createdAt) &&
    approvalNotExpired;
  const boundToDraft =
    approvalValid &&
    approval.draftId === draft.id &&
    approval.draftHash === draft.contentHash;
  const boundToRecipient = approvalValid && approval.recipientEmail === recipientInput;
  const boundToProspect = approvalValid && approval.leadId === leadId;
  const approvalBound = boundToDraft && boundToRecipient && boundToProspect;

  const approvalStatus = {
    required: true,
    valid: approvalValid,
    boundToDraft,
    boundToRecipient,
    boundToProspect,
  };

  pass({
    id: "approval",
    label: "Human approval is bound to this exact outreach",
    passed: approvalBound,
    detail: !approval
      ? "No human approval exists for this draft."
      : approval.status !== "valid"
        ? `Approval status is "${approval.status}".`
        : !approvalNotExpired
          ? "Approval is expired."
          : !boundToDraft
            ? "Approval is not bound to this exact draft content."
            : !boundToRecipient
              ? "Approval is not bound to this recipient."
              : "Approval is not bound to this prospect.",
  });

  if (!approval) {
    return buildResult(
      "WAIT",
      "APPROVAL_MISSING",
      "No human approval exists for this exact outreach; awaiting approval.",
      { approval: approvalStatus },
    );
  }
  if (approval.status === "revoked") {
    return buildResult(
      "REJECT",
      "APPROVAL_REVOKED",
      "The human approval was revoked; transport is blocked.",
      { approval: approvalStatus },
    );
  }
  if (!approvalNotExpired) {
    return buildResult(
      "WAIT",
      "APPROVAL_EXPIRED",
      "The human approval is expired; awaiting renewed approval.",
      { approval: approvalStatus },
    );
  }
  if (!approvalBound) {
    return buildResult(
      "REJECT",
      "APPROVAL_NOT_BOUND",
      "The human approval is not bound to the exact recipient, draft and prospect for this transport.",
      { approval: approvalStatus },
    );
  }

  // --- provider (LAST; configuration can never override safety) -------------
  pass({
    id: "provider",
    label: "Transport provider is explicitly supported and configured",
    passed: false,
    detail: !providerId
      ? "No transport provider is configured (EMAIL_TRANSPORT_PROVIDER is unset)."
      : undefined,
  });
  if (!providerId) {
    return buildResult(
      "WAIT",
      "PROVIDER_MISSING",
      "No transport provider is configured; waiting for provider configuration.",
    );
  }
  const supported = (SUPPORTED_TRANSPORT_PROVIDERS as readonly string[]).includes(
    providerId,
  );
  pass({
    id: "provider_supported",
    label: "Transport provider is supported",
    passed: supported,
    detail: supported
      ? undefined
      : `Provider "${providerId}" is not in the supported set.`,
  });
  if (!supported) {
    return buildResult(
      "REJECT",
      "PROVIDER_NOT_SUPPORTED",
      `Transport provider "${providerId}" is not supported.`,
    );
  }
  const configured = options.transportConfigured ?? defaultEnvConfigured();
  pass({
    id: "provider_configured",
    label: "Transport provider is configured",
    passed: configured,
    detail: configured
      ? undefined
      : "EMAIL_TRANSPORT_CONFIGURED is not set to true.",
  });
  if (!configured) {
    return buildResult(
      "WAIT",
      "PROVIDER_NOT_CONFIGURED",
      "The transport provider is not configured; waiting for configuration.",
    );
  }

  return {
    decision: "TRANSPORT_READY",
    code: "TRANSPORT_READY",
    reason:
      "All transport safety gates passed: Agent 8 authorized SEND, the exact outreach is approved and unchanged, there is no opt-out or duplicate, the current website version has a verified live deployment, and an explicit supported transport provider is configured. Intent only — nothing was sent.",
    prospectId: leadId,
    draftId: draft.id,
    campaignId,
    recipient: { email: recipientInput },
    approval: {
      required: true,
      valid: true,
      boundToDraft,
      boundToRecipient,
      boundToProspect,
    },
    agent8: { decision: input.agent8Decision ?? null },
    provider: { id: providerId, supported, configured },
    website: {
      currentVersionId: currentVersion.projectId,
      deploymentUrl: readyDeployment.deploymentUrl,
      deploymentStatus: readyDeployment.status,
      ready: true,
    },
    duplicate: { key: idempotencyKey, alreadyProcessed: false },
    blockingIssues,
    checks: [
      ...checks,
      {
        id: "transport_verified",
        label: "Transport may proceed (intent only)",
        passed: true,
      },
    ],
    execute: false,
  };
}