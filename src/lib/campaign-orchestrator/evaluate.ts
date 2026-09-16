/**
 * Campaign Orchestrator (Agent 9 / Step 15) — deterministic next-action
 * evaluation.
 *
 * For a single prospect this reports the next legal state in the campaign
 * state machine. Every decision is derived entirely from trusted application
 * state (campaigns, leads, research, website versions, deployments, outreach
 * drafts/approvals/opt-outs/sends). Untrusted content (draft copy, replies,
 * research notes, website copy) can only ever BLOCK — it can never authorize,
 * never override STOP/PAUSE, and never change a recipient/hash/version.
 *
 * This module performs NO side effects: it never sends email, never deploys,
 * never writes outreach send authorizations, and never creates
 * websites/deployments/drafts/approvals. `execute` is always `false`.
 */

import { getLeadById } from "@/lib/data/leads";
import { getCampaign, listCampaignIdsByLeadId } from "@/lib/data/campaigns";
import { getResearchByLeadId } from "@/lib/data/research";
import {
  getCurrentWebsiteVersion,
  getLatestWebsiteVersion,
} from "@/lib/data/websites";
import {
  isActiveDeploymentStatus,
  listDeploymentRecordsByLead,
} from "@/lib/data/deployments";
import {
  getOutreachOptOut,
  getOutreachSendByBinding,
  listOutreachDraftsByLead,
} from "@/lib/data/outreach";
import { getValidDeploymentApproval } from "@/lib/data/deployment-approvals";
import {
  evaluateSendSafety,
  mapCampaignRunState,
  normalizeRecipientEmail,
} from "@/lib/outreach-safety/safety";
import { detectOptOutSignal } from "@/lib/outreach-safety/content-safety";
import {
  evaluateTransportSafety,
  mapTransportDecision,
} from "@/lib/transport-safety";
import type { DeploymentApprovalRow } from "@/lib/data/deployment-approvals";
import type { DeploymentRecord } from "@/lib/data/deployments";
import type {
  CampaignState,
  OrchestratorCheck,
  OrchestratorInput,
  OrchestratorOptions,
  OrchestratorResult,
} from "@/lib/campaign-orchestrator/types";

const NEXT_ACTION_TEXT: Record<CampaignState, string> = {
  DISCOVER_LEADS: "Record/discover this prospect.",
  QUALIFY_LEADS: "Run qualification for this prospect.",
  RESEARCH_BUSINESS: "Run business research for this prospect.",
  CREATE_WEBSITE: "Generate the website specification from research.",
  CODE_WEBSITE: "Code/build the website artifact for the pending version.",
  RUN_WEBSITE_QA: "Run QA on the built website.",
  FIX_WEBSITE: "Fix the website issues and record a new version.",
  CHECK_DEPLOYMENT_ELIGIBILITY:
    "Verify the current website version is deployable (build, QA, artifact hash).",
  WAIT_FOR_DEPLOYMENT_APPROVAL:
    "Await a human approval bound to the exact version and artifact hash.",
  DEPLOY_WEBSITE:
    "Deploy the approved current version (never automatic).",
  CREATE_OUTREACH_DRAFT: "Generate the outreach draft for the verified deployment.",
  CHECK_OUTREACH_SAFETY: "Run the outreach send-safety evaluation.",
  WAIT_FOR_OUTREACH_APPROVAL:
    "Await a human approval bound to this exact outreach.",
  READY_FOR_TRANSPORT:
    "No action required; the prospect is ready for transport (nothing sent).",
  WAIT: "Waiting; nothing may proceed right now.",
  RETRY_STEP: "Retry the failed step.",
  SKIP_PROSPECT: "Drop this prospect; it cannot proceed.",
  STOP: "All activity for this campaign is stopped.",
  COMPLETE: "Prospect processing is complete.",
};

/**
 * Maps an Agent 8 outreach decision to the orchestrator's state machine.
 * Unknown/absent decisions fail closed to SKIP_PROSPECT — a decision can never
 * be treated as authorizing anything.
 */
export function mapOutreachDecision(decision: unknown): CampaignState {
  switch (decision) {
    case "SEND":
      return "READY_FOR_TRANSPORT";
    case "WAIT_FOR_APPROVAL":
      return "WAIT_FOR_OUTREACH_APPROVAL";
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

function deploymentApprovalValid(
  approval: DeploymentApprovalRow | null,
): boolean {
  return (
    approval !== null &&
    approval.status === "valid" &&
    Boolean(approval.createdBy) &&
    Boolean(approval.createdAt) &&
    (approval.expiresAt === null ||
      approval.expiresAt === "" ||
      new Date(approval.expiresAt).getTime() > Date.now())
  );
}

/** Current version is deployable only when build success + QA pass + hash. */
function versionDeployable(current: {
  buildStatus: string | null;
  qaStatus: string | null;
  artifactHash: string | null;
}): boolean {
  return (
    current.buildStatus === "success" &&
    current.qaStatus === "pass" &&
    Boolean(current.artifactHash)
  );
}

function readyDeploymentForCurrent(
  deployments: DeploymentRecord[],
  currentVersionId: string,
): DeploymentRecord | null {
  return (
    deployments.find(
      (d) =>
        d.status === "ready" &&
        d.deploymentUrl !== null &&
        d.websiteVersionId === currentVersionId,
    ) ?? null
  );
}

export function evaluateNextAction(
  input: OrchestratorInput,
  options: OrchestratorOptions = {},
): OrchestratorResult {
  const leadId = input.leadId;
  const iteration = input.iteration ?? 0;
  const checks: OrchestratorCheck[] = [];
  const blockingIssues: string[] = [];
  let campaignId: string | null = null;

  const buildResult = (
    state: CampaignState,
    reason: string,
    blocking: string[] = blockingIssues,
  ): OrchestratorResult => ({
    leadId,
    campaignId,
    state,
    reason,
    nextAction: NEXT_ACTION_TEXT[state],
    checks: [...checks],
    blockingIssues: blocking,
    execute: false,
    iteration,
  });

  // --- stop requested (durable; overrides everything) -----------------------
  const stopRequested = options.stopRequested === true;
  checks.push({
    id: "stop_requested",
    label: "Run has not been stopped",
    passed: !stopRequested,
    detail: stopRequested ? "The job controller requested a stop." : undefined,
  });
  if (stopRequested) {
    return buildResult(
      "STOP",
      "A stop was requested; no further action is authorized.",
      ["Stop was requested; no further action is authorized."],
    );
  }

  // --- prospect --------------------------------------------------------------
  const lead = getLeadById(leadId);
  checks.push({
    id: "lead",
    label: "Prospect exists",
    passed: lead !== null,
    detail: lead ? undefined : "Prospect not found.",
  });
  if (!lead) {
    return buildResult(
      "DISCOVER_LEADS",
      "The prospect has not been discovered yet.",
      ["Prospect record not found."],
    );
  }

  // --- opt-out (recorded and/or signalled in untrusted reply text) ----------
  const recordedOptOut = getOutreachOptOut(leadId);
  const replyOptOut = input.replyText ? detectOptOutSignal(input.replyText) : [];
  const optOut = Boolean(recordedOptOut) || replyOptOut.length > 0;
  checks.push({
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
      "The prospect has opted out of contact.",
      ["Prospect opted out."],
    );
  }

  // --- campaign + run state --------------------------------------------------
  const leadCampaignId =
    lead.campaignId ?? listCampaignIdsByLeadId(leadId)[0] ?? null;
  if (
    input.campaignId &&
    leadCampaignId &&
    input.campaignId !== leadCampaignId
  ) {
    checks.push({
      id: "campaign_binding",
      label: "Evaluation context matches this prospect's campaign",
      passed: false,
      detail: `Requested campaign "${input.campaignId}" differs from the prospect's campaign.`,
    });
    return buildResult(
      "WAIT",
      "The campaign context does not match this prospect; nothing can proceed.",
      ["Campaign context mismatch."],
    );
  }
  campaignId = input.campaignId ?? leadCampaignId;
  const campaign = campaignId ? getCampaign(campaignId) : null;
  checks.push({
    id: "campaign",
    label: "Campaign exists for this prospect",
    passed: campaign !== null,
    detail: campaign
      ? undefined
      : "No campaign is associated with this prospect.",
  });
  if (!campaign) {
    return buildResult(
      "WAIT",
      "No campaign is associated with this prospect.",
      ["No campaign associated with the prospect."],
    );
  }

  const runState = mapCampaignRunState(campaign.status);
  checks.push({
    id: "campaign_state",
    label: "Campaign is running",
    passed: runState === "running",
    detail: `Campaign status is "${campaign.status}".`,
  });
  if (runState === "stopped") {
    return buildResult(
      "STOP",
      "The campaign is stopped; no further action is authorized.",
      ["Campaign is stopped."],
    );
  }
  if (runState === "paused") {
    return buildResult(
      "WAIT",
      "The campaign is paused; waiting for resume.",
      ["Campaign is paused."],
    );
  }

  // --- qualification gate ----------------------------------------------------
  const qualification = lead.qualification;
  const websiteOpportunity = qualification?.websiteOpportunity ?? null;
  checks.push({
    id: "qualification",
    label: "Prospect is qualified with deterministic website evidence",
    passed:
      qualification?.qualificationStatus === "complete" &&
      qualification?.qualified === true &&
      (websiteOpportunity === "NO_WEBSITE" ||
        websiteOpportunity === "NEEDS_REDESIGN"),
    detail: qualification
      ? `websiteOpportunity: ${websiteOpportunity ?? "unknown"}`
      : "No qualification is recorded.",
  });

  if (!qualification || qualification.qualificationStatus !== "complete") {
    return buildResult(
      "QUALIFY_LEADS",
      "The prospect has not been qualified yet.",
      ["Qualification is missing or unavailable."],
    );
  }
  if (websiteOpportunity === "GOOD_WEBSITE") {
    return buildResult(
      "SKIP_PROSPECT",
      "The prospect already has a functioning website; it is not an opportunity.",
      ["Website opportunity is GOOD_WEBSITE."],
    );
  }
  if (websiteOpportunity === "UNKNOWN") {
    return buildResult(
      "SKIP_PROSPECT",
      "The prospect's website status is unknown; it cannot proceed.",
      ["Website opportunity is UNKNOWN."],
    );
  }
  if (websiteOpportunity !== "NO_WEBSITE" && websiteOpportunity !== "NEEDS_REDESIGN") {
    return buildResult(
      "SKIP_PROSPECT",
      "The prospect's website status is not determinable; it cannot proceed.",
      ["Website status is not determinable."],
    );
  }
  if (qualification.qualified !== true) {
    return buildResult(
      "SKIP_PROSPECT",
      `The prospect is not qualified: ${qualification.reason ?? "niche or location relevance did not pass."}`,
      ["Prospect is not qualified."],
    );
  }

  // --- research gate ---------------------------------------------------------
  const research = getResearchByLeadId(leadId);
  checks.push({
    id: "research",
    label: "Business research exists",
    passed: research !== null,
    detail: research ? undefined : "No research is recorded.",
  });
  if (!research) {
    return buildResult(
      "RESEARCH_BUSINESS",
      "Business research is required before a website can be created.",
      ["Research is missing."],
    );
  }
  checks.push({
    id: "research_uncertainty",
    label: "Research records unknowns honestly",
    passed: Array.isArray(research.websiteResearch.unknowns),
    detail:
      research.websiteResearch.unknowns.length > 0
        ? `${research.websiteResearch.unknowns.length} unknown(s) recorded; only verified facts may be asserted.`
        : undefined,
  });

  // --- website stage ---------------------------------------------------------
  const latest = getLatestWebsiteVersion(leadId);
  checks.push({
    id: "website_project",
    label: "Website version exists",
    passed: latest !== null,
    detail: latest ? undefined : "No website version exists.",
  });
  if (!latest) {
    return buildResult(
      "CREATE_WEBSITE",
      "A website must be created from the verified research.",
      ["No website version exists."],
    );
  }

  switch (latest.status) {
    case "draft":
      return buildResult(
        "CODE_WEBSITE",
        "The website draft must be coded and built.",
        [],
      );
    case "building":
      return buildResult("WAIT", "The website build is in progress.", []);
    case "qa":
      if (latest.qaStatus === "fail") {
        return buildResult(
          "FIX_WEBSITE",
          "QA found issues in the website that must be fixed.",
          ["Website QA failed."],
        );
      }
      if (latest.qaStatus === "pass") break;
      // Integration fix: a version parked in the QA stage (qaStatus pending or
      // qa) is actionable by the campaign runner, which resumes the QA stage
      // through the existing QA agent. A permanent WAIT here would deadlock the
      // pipeline the instant a build leaves a 'qa' status behind.
      return buildResult(
        "RUN_WEBSITE_QA",
        "QA is in progress or pending; the runner may resume the QA stage.",
        [],
      );
    case "failed":
      return buildResult(
        "FIX_WEBSITE",
        "The website build or QA failed and must be fixed.",
        ["Website version failed."],
      );
    case "stopped":
      return buildResult(
        "STOP",
        "Website work for this prospect was stopped.",
        ["Website version stopped."],
      );
    case "completed":
    case "ready":
    case "current":
      break;
    default:
      return buildResult(
        "WAIT",
        `The website version is in an indeterminate state ("${latest.status}").`,
        ["Website version is in an indeterminate state."],
      );
  }

  // --- deployment eligibility ------------------------------------------------
  const current = getCurrentWebsiteVersion(leadId);
  if (!current) {
    if (latest.status === "ready") {
      return buildResult(
        "CHECK_DEPLOYMENT_ELIGIBILITY",
        "The verified version is ready but must be promoted to current and verified before deployment.",
        ["Current version is not set."],
      );
    }
    return buildResult(
      "WAIT",
      "No current website version exists.",
      ["No current website version."],
    );
  }
  if (latest.status === "ready" && current.projectId !== latest.projectId) {
    return buildResult(
      "CHECK_DEPLOYMENT_ELIGIBILITY",
      "A newer verified version is ready but is not yet the current version.",
      ["Newer version is not current."],
    );
  }

  const deployable = versionDeployable(current);
  checks.push({
    id: "deployment_eligibility",
    label: "Current version passed build, QA and artifact hash",
    passed: deployable,
    detail: deployable
      ? undefined
      : current.buildStatus !== "success"
        ? "Build has not passed."
        : current.qaStatus !== "pass"
          ? "QA has not passed."
          : "No artifact hash is recorded.",
  });
  if (!deployable) {
    return buildResult(
      "CHECK_DEPLOYMENT_ELIGIBILITY",
      "The current version is not yet verified for deployment.",
      ["Current version is not deployable (build/QA/artifact hash)."],
    );
  }

  // --- deployment approval ---------------------------------------------------
  const deployApproval = getValidDeploymentApproval(current.projectId);
  const isDeployApprovalValid = deploymentApprovalValid(deployApproval);
  const deployApprovalBound =
    isDeployApprovalValid &&
    deployApproval !== null &&
    deployApproval.websiteVersionId === current.projectId &&
    deployApproval.artifactHash === current.artifactHash;
  checks.push({
    id: "deployment_approval",
    label: "Human approval is bound to the exact current version and artifact hash",
    passed: deployApprovalBound,
    detail: !deployApproval
      ? "No human approval exists."
      : !isDeployApprovalValid
        ? "Approval is not valid."
        : deployApproval.websiteVersionId !== current.projectId
          ? "Approval is bound to a different version."
          : "Approval is bound to a different artifact hash.",
  });
  if (!deployApprovalBound) {
    return buildResult(
      "WAIT_FOR_DEPLOYMENT_APPROVAL",
      "Awaiting a human approval bound to the exact current version and artifact hash.",
      ["No valid bound deployment approval."],
    );
  }

  // --- deployment status -----------------------------------------------------
  const deployments = listDeploymentRecordsByLead(leadId);
  const readyDeployment = readyDeploymentForCurrent(
    deployments,
    current.projectId,
  );
  if (!readyDeployment) {
    const active = deployments.find((d) => isActiveDeploymentStatus(d.status));
    const failed = deployments.find(
      (d) => d.status === "failed" || d.status === "cancelled",
    );
    checks.push({
      id: "deployment",
      label: "Current version is deployed and live",
      passed: false,
      detail: active
        ? `A deployment is in progress (${active.status}).`
        : failed
          ? `A previous deployment ended in ${failed.status}.`
          : "No deployment record exists for the current version.",
    });
    if (active) {
      return buildResult("WAIT", "A deployment is in progress.", [
        "Deployment in progress.",
      ]);
    }
    if (failed) {
      return buildResult(
        "RETRY_STEP",
        "A previous deployment failed; the step can be retried.",
        ["Previous deployment failed."],
      );
    }
    return buildResult(
      "DEPLOY_WEBSITE",
      "The approved current version may be deployed (never automatic).",
      [],
    );
  }
  checks.push({
    id: "deployment",
    label: "Current version is deployed and live",
    passed: true,
    detail: `Deployed at ${readyDeployment.deploymentUrl}.`,
  });

  // --- outreach draft --------------------------------------------------------
  const drafts = listOutreachDraftsByLead(leadId);
  const eligibleDraft = drafts.find((d) => d.status === "eligible") ?? null;
  checks.push({
    id: "outreach_draft",
    label: "An eligible outreach draft exists",
    passed: eligibleDraft !== null,
    detail:
      drafts.length === 0
        ? "No draft exists."
        : `Latest draft status is "${drafts[0].status}".`,
  });
  if (!eligibleDraft) {
    if (drafts.length === 0) {
      return buildResult(
        "CREATE_OUTREACH_DRAFT",
        "An outreach draft must be created for the verified deployment.",
        ["No outreach draft exists."],
      );
    }
    if (drafts[0].status === "blocked") {
      return buildResult(
        "SKIP_PROSPECT",
        "The outreach draft was blocked; the prospect cannot proceed.",
        ["Outreach draft is blocked."],
      );
    }
    return buildResult(
      "WAIT",
      "The outreach draft is awaiting review.",
      ["Outreach draft is pending review."],
    );
  }

  // --- verified recipient ----------------------------------------------------
  const contact = lead.contactDiscovery;
  const recipientEmail =
    contact?.emailStatus === "found" &&
    (contact.emailConfidence === "high" ||
      contact.emailConfidence === "medium") &&
    contact.email
      ? normalizeRecipientEmail(contact.email)
      : null;
  checks.push({
    id: "recipient_verified",
    label: "Prospect has a verified contact email",
    passed: recipientEmail !== null,
    detail: recipientEmail
      ? undefined
      : `Email status: ${contact?.emailStatus ?? "none"}.`,
  });
  if (!recipientEmail) {
    return buildResult(
      "SKIP_PROSPECT",
      "No verified contact email exists for this prospect.",
      ["No verified recipient email."],
    );
  }

  // --- outreach send-safety (Agent 8 decision mapping) -----------------------
  const alreadyAuthorized =
    getOutreachSendByBinding({
      leadId,
      draftId: eligibleDraft.id,
      recipientEmail: recipientEmail,
      draftHash: eligibleDraft.contentHash,
    }) !== null;
  if (alreadyAuthorized) {
    checks.push({
      id: "duplicate",
      label: "This exact outreach is not already processed",
      passed: false,
      detail: "A send authorization already exists for this exact outreach.",
    });
    return buildResult(
      "COMPLETE",
      "This exact outreach was already authorized; processing is complete.",
      [],
    );
  }

  const safety = evaluateSendSafety(
    {
      leadId,
      draftId: eligibleDraft.id,
      recipientEmail: recipientEmail,
      replyText: input.replyText,
      untrustedContext: input.untrustedContext,
    },
    {
      stopRequested,
      transportAvailable: options.transportAvailable,
      recordAuthorization: false,
      verifiedServices: research.websiteResearch.services,
    },
  );
  checks.push({
    id: "outreach_safety",
    label: "Outreach send-safety evaluation passed",
    passed: safety.decision === "SEND",
    detail: safety.reason,
  });

  const safetyState = mapOutreachDecision(safety.decision);
  if (safetyState === "READY_FOR_TRANSPORT") {
    // Agent 10 (transport safety) is an independent gate: Agent 8 authorizing
    // SEND is necessary but never sufficient. READY_FOR_TRANSPORT is only
    // reachable when Agent 10 also returns TRANSPORT_READY, so Agent 9 can
    // never bypass Agent 10.
    const transport = evaluateTransportSafety(
      {
        leadId,
        draftId: eligibleDraft.id,
        recipientEmail,
        campaignId,
        agent8Decision: safety.decision,
        replyText: input.replyText,
        untrustedContext: input.untrustedContext,
        provider: options.transportProvider,
      },
      {
        stopRequested,
        transportConfigured: options.transportConfigured,
      },
    );
    checks.push({
      id: "transport_safety",
      label: "Transport safety gate (Agent 10) passed",
      passed: transport.decision === "TRANSPORT_READY",
      detail: transport.reason,
    });
    blockingIssues.push(...transport.blockingIssues);
    if (transport.decision === "TRANSPORT_READY") {
      return buildResult(
        "READY_FOR_TRANSPORT",
        "All safety gates passed and a human approval is bound to this exact outreach. Intent only — nothing was sent.",
        [],
      );
    }
    const transportState = mapTransportDecision(transport.decision);
    return buildResult(
      transportState,
      transport.reason,
      transport.blockingIssues.length > 0
        ? transport.blockingIssues
        : [transport.reason],
    );
  }
  return buildResult(safetyState, safety.reason, safety.blockingIssues.length > 0 ? safety.blockingIssues : [safety.reason]);
}