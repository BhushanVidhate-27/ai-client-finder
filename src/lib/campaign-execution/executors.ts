/**
 * Campaign Execution (Step 16) — executor map.
 *
 * Every state that Agent 9 may emit is mapped to an executor that delegates
 * to the production infrastructure of the corresponding A1–A8 component.
 * The executors perform DB writes and filesystem mutations but never grant
 * permissions, send email, or bypass a deployment safety gate — those
 * decisions belong to the evaluation engine and the individual flows.
 */

import { JobController, JobStoppedError } from "@/lib/jobs/controller";
import { updateJob } from "@/lib/data/jobs";
import { logActivity } from "@/lib/data/activity";
import {
  upsertLeadFromDiscovery,
  setLeadPrimaryCampaign,
  getLeadById,
  toQualifiedLead,
} from "@/lib/data/leads";
import {
  linkCampaignLead,
  type CampaignRow,
} from "@/lib/data/campaigns";
import { upsertResearch, getResearchByLeadId } from "@/lib/data/research";
import {
  getCurrentWebsiteVersion,
  getLatestWebsiteVersion,
  promoteWebsiteVersion,
  updateWebsiteVersionResult,
  markWebsiteVersionStopped,
  markWebsiteVersionFailed,
} from "@/lib/data/websites";
import { listDeploymentRecordsByLead } from "@/lib/data/deployments";
import {
  createOutreachDraft,
  listOutreachDraftsByLead,
} from "@/lib/data/outreach";
import { discoveryPoolSize, selectProspects } from "@/lib/website-opportunity";
import { runWebsiteProjectGeneration } from "@/lib/jobs/website-project-flow";
import { runWebsiteDeployment } from "@/lib/jobs/website-deployment-flow";
import { runAgentLoop } from "@/lib/agents/loop-engine";
import { createWebsiteCodingAgent } from "@/lib/website-coding/agent";
import { createWebsiteQaAgent } from "@/lib/website-qa/agent";
import { readBuildManifest } from "@/lib/website-coding/workspace";
import { hashWorkspace } from "@/lib/website-coding/source-hash";
import { evaluateNextAction } from "@/lib/campaign-orchestrator/evaluate";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import type { CampaignState } from "@/lib/campaign-orchestrator/types";
import { buildSafeOutreachDraft } from "./drafts";
import type {
  CampaignExecutionServices,
  ProspectProgress,
  ProspectRunSummary,
} from "./types";

// ---------------------------------------------------------------------------
// Context builders (mirror website-project-flow, not exported from there)
// ---------------------------------------------------------------------------

function codingAgentContext(
  stored: { id: string; businessName: string },
  researchRef: unknown,
  contact: ContactDiscovery | null,
  workspaceId: string,
) {
  return {
    goal: {
      description: "Create a static website for the qualified prospect.",
      acceptanceCriteria: [
        "A multi-page static website exists in the isolated workspace.",
        "All required files build and validate.",
        "Only verified facts and research content are used.",
      ],
    },
    constraints: [],
    references: {
      lead: { id: stored.id, businessName: stored.businessName },
      research: researchRef,
      contact,
      projectId: workspaceId,
    },
  };
}

function qaAgentContext(
  stored: { id: string; businessName: string },
  researchRef: unknown,
  contact: ContactDiscovery | null,
  workspaceId: string,
) {
  return {
    goal: {
      description: "QA the generated website, apply safe deterministic fixes, and validate.",
      acceptanceCriteria: [
        "No medium-or-higher issues remain.",
        "Final deterministic build validation succeeds.",
      ],
    },
    constraints: [],
    references: {
      lead: { id: stored.id, businessName: stored.businessName },
      research: researchRef,
      contact,
      projectId: workspaceId,
    },
  };
}

// ---------------------------------------------------------------------------
// State classification helpers
// ---------------------------------------------------------------------------

/** Terminal states — the runner stops iterating that prospect entirely. */
export const TERMINAL_STATES = new Set<CampaignState>([
  "SKIP_PROSPECT",
  "COMPLETE",
  "READY_FOR_TRANSPORT",
]);

/**
 * Parking states — the prospect is waiting on an external event (human
 * approval, admin action, build finish, etc.) and cannot make progress
 * within this invocation.
 */
export const PARKING_STATES = new Set<CampaignState>([
  "WAIT",
  "WAIT_FOR_DEPLOYMENT_APPROVAL",
  "WAIT_FOR_OUTREACH_APPROVAL",
]);

/** States for which an executor is defined and must run. */
export const EXECUTABLE_STATES = new Set<CampaignState>([
  "DISCOVER_LEADS",
  "QUALIFY_LEADS",
  "RESEARCH_BUSINESS",
  "CREATE_WEBSITE",
  "CODE_WEBSITE",
  "RUN_WEBSITE_QA",
  "FIX_WEBSITE",
  "CHECK_DEPLOYMENT_ELIGIBILITY",
  "DEPLOY_WEBSITE",
  "RETRY_STEP",
  "CREATE_OUTREACH_DRAFT",
  "CHECK_OUTREACH_SAFETY",
]);

export function classifyAction(
  state: CampaignState,
): "executable" | "terminal" | "parking" {
  if (EXECUTABLE_STATES.has(state)) return "executable";
  if (TERMINAL_STATES.has(state)) return "terminal";
  return "parking";
}

// ---------------------------------------------------------------------------
// Campaign-level discovery (link prospects into the campaign)
// ---------------------------------------------------------------------------

export async function runDiscoveryForCampaign(
  campaign: CampaignRow,
  controller: JobController,
  services: CampaignExecutionServices,
): Promise<number> {
  const discover =
    services.discoverLeads ?? (await import("@/lib/google-places")).searchPlaces;
  const qualifyFn =
    services.qualifyLeads ?? (await import("@/lib/lead-qualification")).qualifyLeads;

  const discovered = await discover(
    campaign.niche,
    campaign.location,
    campaign.requestedLeadCount,
    { discoveryPool: discoveryPoolSize(campaign.requestedLeadCount) },
  );

  updateJob(controller.jobId, {
    progress: 30,
    currentStep: `discovered ${discovered.length} candidates`,
  });
  await controller.checkpoint();

  const qualified = await qualifyFn(campaign.niche, campaign.location, discovered);
  const prospects = selectProspects(qualified, campaign.requestedLeadCount);

  updateJob(controller.jobId, {
    progress: 70,
    currentStep: `qualifying ${prospects.length} genuine opportunities`,
  });

  let count = 0;
  for (const ql of prospects) {
    const { lead: stored, created } = upsertLeadFromDiscovery(ql, { updateExisting: true });
    if (created) {
      setLeadPrimaryCampaign(stored.id, campaign.id);
      logActivity({
        action: "lead.discovered",
        campaignId: campaign.id,
        leadId: stored.id,
        jobId: controller.jobId,
        metadata: { placeId: stored.placeId, triggeredBy: "execution_runner" },
      });
    }
    linkCampaignLead(campaign.id, stored.id);
    count += 1;
  }

  updateJob(controller.jobId, {
    progress: 100,
    currentStep: `discovery complete: ${count} prospects linked`,
  });
  logActivity({
    action: "campaign.discovery_completed",
    campaignId: campaign.id,
    jobId: controller.jobId,
    metadata: { discovered: discovered.length, linked: count },
  });

  return count;
}

// ---------------------------------------------------------------------------
// Per-prospect executors
// ---------------------------------------------------------------------------

async function executeQualify(
  leadId: string,
  campaign: CampaignRow,
  controller: JobController,
  services: CampaignExecutionServices,
): Promise<void> {
  const stored = getLeadById(leadId);
  if (!stored) throw new Error("Prospect disappeared before qualification could run.");
  const qualifyFn =
    services.qualifyLeads ?? (await import("@/lib/lead-qualification")).qualifyLeads;
  const [result] = await qualifyFn(campaign.niche, campaign.location, [
    toQualifiedLead(stored),
  ]);
  if (result) upsertLeadFromDiscovery(result, { updateExisting: true });
  updateJob(controller.jobId, {
    progress: 100,
    currentStep: "qualification refreshed",
  });
}

async function executeResearch(
  leadId: string,
  controller: JobController,
  services: CampaignExecutionServices,
): Promise<void> {
  const stored = getLeadById(leadId);
  if (!stored) throw new Error("Prospect disappeared before research could run.");
  const lead = toQualifiedLead(stored);
  const contactMap = new Map<string, ContactDiscovery | null | undefined>();
  if (stored.contactDiscovery) contactMap.set(stored.placeId, stored.contactDiscovery);

  const researchFn =
    services.researchLeads ?? (await import("@/lib/lead-research")).researchLeads;

  const results = await researchFn([lead], contactMap, 1, {
    beforeLead: async () => controller.checkpoint(),
  });
  const first = results[0];
  if (first?.status === "complete" && first.websiteResearch) {
    upsertResearch(leadId, first.websiteResearch);
  }
  if (!first || first.status !== "complete" || !first.websiteResearch) {
    throw new Error(
      first?.errorMessage ?? "Research produced no usable website research.",
    );
  }
  updateJob(controller.jobId, { progress: 100, currentStep: "research complete" });
}

async function executeWebsiteCreation(
  leadId: string,
  controller: JobController,
  services: CampaignExecutionServices,
): Promise<void> {
  const stored = getLeadById(leadId);
  const research = getResearchByLeadId(leadId);
  if (!stored || !research?.websiteResearch)
    throw new Error("Prospect or research missing before website generation.");

  await runWebsiteProjectGeneration(
    {
      leadId: stored.id,
      lead: toQualifiedLead(stored),
      contact: stored.contactDiscovery,
      research: research.websiteResearch,
      controller,
    },
    { codingAgent: services.codingAgent, qaAgent: services.qaAgent },
  );

  updateJob(controller.jobId, { progress: 100, currentStep: "website generated and promoted" });
}

async function executeCodeDraft(
  leadId: string,
  controller: JobController,
  services: CampaignExecutionServices,
): Promise<void> {
  const stored = getLeadById(leadId);
  const research = getResearchByLeadId(leadId);
  const latest = getLatestWebsiteVersion(leadId);
  if (!stored || !research?.websiteResearch || !latest || latest.status !== "draft")
    throw new Error("No draft website version is available to code.");

  const workspaceId = latest.workspaceId!;
  const codingAgent = services.codingAgent ?? createWebsiteCodingAgent();
  await controller.checkpoint();

  updateWebsiteVersionResult(latest.projectId, {
    status: "building",
    buildStatus: "building",
  });
  updateJob(controller.jobId, {
    progress: 20,
    currentStep: `coding draft v${latest.version}`,
  });

  const coding = await runAgentLoop({
    agent: codingAgent,
    context: codingAgentContext(stored, research.websiteResearch, stored.contactDiscovery, workspaceId),
    controller,
  });

  if (coding.status === "stopped") {
    markWebsiteVersionStopped(latest.projectId);
    throw new JobStoppedError();
  }
  if (coding.status !== "completed") {
    markWebsiteVersionFailed(latest.projectId, {
      stage: "coding",
      reason: coding.error ?? "Coding agent failed.",
    });
    throw new Error(coding.error ?? "Coding agent failed.");
  }

  const manifest = await readBuildManifest(workspaceId);
  if (!manifest || manifest.status !== "success") {
    markWebsiteVersionFailed(latest.projectId, {
      stage: "coding",
      reason: "Coding completed without a successful build manifest.",
    });
    throw new Error("Coding completed without a successful build manifest.");
  }

  await controller.checkpoint();
  updateWebsiteVersionResult(latest.projectId, {
    status: "qa",
    buildStatus: "success",
    qaStatus: "qa",
  });
  updateJob(controller.jobId, {
    progress: 80,
    currentStep: `draft v${latest.version} ready for QA`,
  });
}

async function executeRunWebsiteQa(
  leadId: string,
  controller: JobController,
  services: CampaignExecutionServices,
): Promise<void> {
  const stored = getLeadById(leadId);
  const research = getResearchByLeadId(leadId);
  const latest = getLatestWebsiteVersion(leadId);
  if (!stored || !research?.websiteResearch || !latest || latest.status !== "qa")
    throw new Error("No in-QA website version is available to process.");

  const workspaceId = latest.workspaceId!;
  const qaAgent = services.qaAgent ?? createWebsiteQaAgent();
  await controller.checkpoint();
  updateJob(controller.jobId, {
    progress: 30,
    currentStep: `running QA v${latest.version}`,
  });

  const qa = await runAgentLoop({
    agent: qaAgent,
    context: qaAgentContext(stored, research.websiteResearch, stored.contactDiscovery, workspaceId),
    controller,
  });

  if (qa.status === "stopped") {
    markWebsiteVersionStopped(latest.projectId);
    throw new JobStoppedError();
  }
  if (qa.status !== "completed") {
    markWebsiteVersionFailed(latest.projectId, {
      stage: "qa",
      reason: qa.error ?? "QA agent failed.",
    });
    throw new Error(qa.error ?? "QA agent failed.");
  }

  const manifest = await readBuildManifest(workspaceId);
  if (!manifest || manifest.status !== "success") {
    markWebsiteVersionFailed(latest.projectId, {
      stage: "qa",
      reason: "QA completed without a successful build manifest.",
    });
    throw new Error("QA completed without a successful build manifest.");
  }

  await controller.checkpoint();
  const artifactHash = await hashWorkspace(workspaceId);
  updateWebsiteVersionResult(latest.projectId, {
    status: "ready",
    buildStatus: "success",
    qaStatus: "pass",
    artifactHash,
  });
  updateJob(controller.jobId, {
    progress: 90,
    currentStep: `v${latest.version} ready for deployment`,
  });
}

async function executePromoteReady(
  leadId: string,
  controller: JobController,
): Promise<void> {
  const latest = getLatestWebsiteVersion(leadId);
  const current = getCurrentWebsiteVersion(leadId);
  if (!latest) throw new Error("No website version exists to promote.");
  if (latest.status === "ready" && (!current || current.projectId !== latest.projectId)) {
    promoteWebsiteVersion(latest.projectId);
    updateJob(controller.jobId, {
      progress: 100,
      currentStep: `promoted v${latest.version} to current`,
    });
  }
}

async function executeDeploy(
  leadId: string,
  controller: JobController,
  services: CampaignExecutionServices,
): Promise<void> {
  await runWebsiteDeployment(
    {
      leadId,
      provider: services.provider ?? "mock",
      controller,
    },
    {
      registry: services.registry,
      deployerAgent: services.deployerAgent,
    },
  );
  updateJob(controller.jobId, { progress: 100, currentStep: "deployment completed" });
}

async function executeCreateOutreachDraft(
  leadId: string,
  controller: JobController,
): Promise<void> {
  const stored = getLeadById(leadId);
  const current = getCurrentWebsiteVersion(leadId);
  if (!stored || !current)
    throw new Error("Prospect or current website version missing for outreach draft.");

  const readyDeployment =
    listDeploymentRecordsByLead(leadId).find(
      (d) =>
        d.status === "ready" &&
        d.deploymentUrl !== null &&
        d.websiteVersionId === current.projectId,
    ) ?? null;

  if (!readyDeployment?.deploymentUrl)
    throw new Error("No verified deployment exists for the current website version.");

  const existingDrafts = listOutreachDraftsByLead(leadId);
  if (existingDrafts.some((d) => d.status === "eligible")) {
    // Another concurrent runner already created the draft.
    return;
  }

  const { subject, body } = buildSafeOutreachDraft({
    businessName: stored.businessName,
    websiteUrl: readyDeployment.deploymentUrl,
  });

  createOutreachDraft({
    leadId,
    subject,
    body,
    status: "eligible",
    websiteVersionId: current.projectId,
    websiteUrl: readyDeployment.deploymentUrl,
  });

  updateJob(controller.jobId, { progress: 100, currentStep: "outreach draft created" });
  logActivity({
    action: "outreach.draft_created",
    leadId,
    jobId: controller.jobId,
    metadata: { websiteVersionId: current.projectId, triggeredBy: "execution_runner" },
  });
}

/**
 * CHECK_OUTREACH_SAFETY is never returned by Agent 9 (the safety evaluation
 * is folded into the state-machine transition). A defensive no-op keeps the
 * runner forward-compatible if the mapping changes.
 */
async function noopExecutor(): Promise<void> {
  // Intentionally empty — the next evaluation re-derives the state.
}

// ---------------------------------------------------------------------------
// Central dispatch
// ---------------------------------------------------------------------------

export async function executeProspectStep(
  state: CampaignState,
  leadId: string,
  campaign: CampaignRow,
  controller: JobController,
  services: CampaignExecutionServices,
): Promise<void> {
  switch (state) {
    case "QUALIFY_LEADS":
      return executeQualify(leadId, campaign, controller, services);
    case "RESEARCH_BUSINESS":
      return executeResearch(leadId, controller, services);
    case "CREATE_WEBSITE":
      return executeWebsiteCreation(leadId, controller, services);
    case "CODE_WEBSITE":
      return executeCodeDraft(leadId, controller, services);
    case "RUN_WEBSITE_QA":
      return executeRunWebsiteQa(leadId, controller, services);
    case "FIX_WEBSITE":
      return executeWebsiteCreation(leadId, controller, services);
    case "CHECK_DEPLOYMENT_ELIGIBILITY":
      return executePromoteReady(leadId, controller);
    case "DEPLOY_WEBSITE":
      return executeDeploy(leadId, controller, services);
    case "RETRY_STEP":
      return executeDeploy(leadId, controller, services);
    case "CREATE_OUTREACH_DRAFT":
      return executeCreateOutreachDraft(leadId, controller);
    case "DISCOVER_LEADS":
    case "CHECK_OUTREACH_SAFETY":
      return noopExecutor();
    default:
      throw new Error(`No executor defined for campaign state "${state}".`);
  }
}

// ---------------------------------------------------------------------------
// Summary builder (read-only; uses Agent 9 as source of truth)
// ---------------------------------------------------------------------------

export interface ProspectEval {
  leadId: string;
  businessName: string;
  state: CampaignState;
  reason: string;
}

export function evaluateProspectForSummary(leadId: string): ProspectEval {
  const result = evaluateNextAction({ leadId });
  const stored = getLeadById(leadId);
  return {
    leadId,
    businessName: stored?.businessName ?? "Unknown",
    state: result.state,
    reason: result.reason,
  };
}

export function buildSummaryLine(
  prospect: ProspectEval,
  progress: ProspectProgress,
): ProspectRunSummary {
  const terminal = TERMINAL_STATES.has(prospect.state);
  return {
    leadId: prospect.leadId,
    businessName: prospect.businessName,
    state: prospect.state,
    reason: prospect.reason,
    parked: Boolean(progress?.parked),
    terminal,
    skipped: progress?.terminal === "skipped" || prospect.state === "SKIP_PROSPECT",
    attempts: progress?.attempts ?? {},
  };
}