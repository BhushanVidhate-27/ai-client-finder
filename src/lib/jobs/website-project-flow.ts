import { runAgentLoop } from "@/lib/agents/loop-engine";
import { JobController, JobStoppedError } from "@/lib/jobs/controller";
import { updateJob } from "@/lib/data/jobs";
import { logActivity } from "@/lib/data/activity";
import { createWebsiteCodingAgent } from "@/lib/website-coding/agent";
import { createWebsiteQaAgent } from "@/lib/website-qa/agent";
import { readBuildManifest } from "@/lib/website-coding/workspace";
import { hashWorkspace } from "@/lib/website-coding/source-hash";
import {
  createWebsiteProjectVersion,
  ensureWebsiteProject,
  getWebsiteProjectRecordByLeadId,
  getWebsiteVersion,
  markWebsiteVersionFailed,
  markWebsiteVersionStopped,
  promoteWebsiteVersion,
  updateWebsiteVersionResult,
  type WebsiteVersionRow,
} from "@/lib/data/websites";
import type { WebsiteResearch } from "@/lib/lead-research";
import type { QualifiedLead } from "@/lib/lead-qualification";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import type { Agent, AgentContext } from "@/lib/agents/types";

export interface WebsiteProjectFlowInput {
  leadId: string;
  lead: QualifiedLead;
  contact: ContactDiscovery | null;
  research: WebsiteResearch;
  controller: JobController;
}

export interface WebsiteProjectFlowOptions {
  /** Override the coding agent (for deterministic tests of pause/stop). */
  codingAgent?: Agent;
  /** Override the QA agent (for deterministic tests). */
  qaAgent?: Agent;
}

export interface WebsiteProjectFlowResult {
  projectId: string;
  websiteProjectId: string;
  leadId: string;
  version: number;
  status: string;
  workspaceId: string;
  artifactHash: string | null;
  buildStatus: string | null;
  qaStatus: string | null;
  businessName: string;
  currentVersion: number;
}

function findProjectRecord(leadId: string) {
  const project = getWebsiteProjectRecordByLeadId(leadId);
  if (!project) {
    throw new Error(`Website project missing for lead "${leadId}".`);
  }
  return project;
}

function codingContext(input: WebsiteProjectFlowInput, workspaceId: string): AgentContext {
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
      lead: input.lead,
      research: input.research,
      contact: input.contact,
      projectId: workspaceId,
    },
  };
}

function qaContext(input: WebsiteProjectFlowInput, workspaceId: string): AgentContext {
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
      lead: input.lead,
      research: input.research,
      contact: input.contact,
      projectId: workspaceId,
    },
  };
}

/**
 * Runs the Step 12 website lifecycle for a lead:
 *
 *   ensure project -> create version (draft) -> coding agent loop (build) ->
 *   QA agent loop (qa) -> final build/hash verification -> atomic promotion
 *
 * The coding and QA agents run inside a single, durable job and share its
 * JobController, so pause/resume/stop gate every agent step. A stopped run
 * persists the version as 'stopped' and never promotes; a failed coding/QA run
 * persists the version as 'failed' and never promotes.
 */
export async function runWebsiteProjectGeneration(
  input: WebsiteProjectFlowInput,
  options: WebsiteProjectFlowOptions = {},
): Promise<WebsiteProjectFlowResult> {
  const { leadId, lead, controller } = input;
  const codingAgent = options.codingAgent ?? createWebsiteCodingAgent();
  const qaAgent = options.qaAgent ?? createWebsiteQaAgent();
  await controller.checkpoint();

  const project = ensureWebsiteProject(leadId);
  updateJob(controller.jobId, {
    progress: 5,
    currentStep: "website project reserved",
  });
  logActivity({
    action: "website.project_created",
    leadId,
    jobId: controller.jobId,
    metadata: { projectId: project.projectId },
  });

  const version = createWebsiteProjectVersion(leadId);
  const workspaceId = version.workspaceId!;
  logActivity({
    action: "website.version_draft_created",
    leadId,
    websiteVersionId: version.projectId,
    jobId: controller.jobId,
    metadata: { version: version.version, workspaceId },
  });

  try {
    // Stage 1 — coding agent (writes the version workspace, builds, validates).
    updateWebsiteVersionResult(version.projectId, {
      status: "building",
      buildStatus: "building",
    });
    updateJob(controller.jobId, {
      progress: 20,
      currentStep: `coding website v${version.version}`,
    });

    const coding = await runAgentLoop({
      agent: codingAgent,
      context: codingContext(input, workspaceId),
      controller,
    });

    if (coding.status === "stopped") {
      markWebsiteVersionStopped(version.projectId);
      updateJob(controller.jobId, { progress: 25, currentStep: "stopped during coding" });
      throw new JobStoppedError();
    }
    if (coding.status !== "completed") {
      markWebsiteVersionFailed(version.projectId, {
        stage: "coding",
        reason: coding.error ?? "Coding agent failed.",
      });
      updateJob(controller.jobId, {
        progress: 25,
        currentStep: `coding failed: ${coding.error ?? "unknown"}`,
      });
      throw new Error(coding.error ?? "Coding agent failed.");
    }

    const codingManifest = await readBuildManifest(workspaceId);
    if (!codingManifest || codingManifest.status !== "success") {
      markWebsiteVersionFailed(version.projectId, {
        stage: "coding",
        reason: "Coding agent completed without a successful build manifest.",
      });
      throw new Error("Coding agent completed without a successful build manifest.");
    }

    await controller.checkpoint();

    // Stage 2 — QA agent (audits, applies deterministic fixes, rebuilds,
    // re-validates).
    updateWebsiteVersionResult(version.projectId, {
      status: "qa",
      qaStatus: "qa",
    });
    updateJob(controller.jobId, {
      progress: 50,
      currentStep: `QA website v${version.version}`,
    });

    const qa = await runAgentLoop({
      agent: qaAgent,
      context: qaContext(input, workspaceId),
      controller,
    });

    if (qa.status === "stopped") {
      markWebsiteVersionStopped(version.projectId);
      updateJob(controller.jobId, { progress: 55, currentStep: "stopped during QA" });
      throw new JobStoppedError();
    }
    if (qa.status !== "completed") {
      markWebsiteVersionFailed(version.projectId, {
        stage: "qa",
        reason: qa.error ?? "QA agent failed.",
      });
      updateJob(controller.jobId, {
        progress: 55,
        currentStep: `QA failed: ${qa.error ?? "unknown"}`,
      });
      throw new Error(qa.error ?? "QA agent failed.");
    }

    const qaManifest = await readBuildManifest(workspaceId);
    if (!qaManifest || qaManifest.status !== "success") {
      markWebsiteVersionFailed(version.projectId, {
        stage: "qa",
        reason: "QA completed without a successful build manifest.",
      });
      throw new Error("QA completed without a successful build manifest.");
    }

    await controller.checkpoint();

    // Stage 3 — final verify: deterministic source hash over the shipped files.
    let artifactHash: string;
    try {
      artifactHash = await hashWorkspace(workspaceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Hashing failed.";
      markWebsiteVersionFailed(version.projectId, { stage: "final", reason: message });
      throw new Error(message);
    }

    updateWebsiteVersionResult(version.projectId, {
      status: "ready",
      buildStatus: "success",
      qaStatus: "pass",
      artifactHash,
      metadata: { businessName: lead.businessName },
    });
    updateJob(controller.jobId, {
      progress: 85,
      currentStep: `v${version.version} ready`,
    });
    logActivity({
      action: "website.version_ready",
      leadId,
      websiteVersionId: version.projectId,
      jobId: controller.jobId,
      metadata: { version: version.version, artifactHash },
    });

    await controller.checkpoint();

    // Stage 4 — atomic promotion.
    const promoted = promoteWebsiteVersion(version.projectId);
    updateJob(controller.jobId, {
      progress: 100,
      currentStep: `current version is v${promoted.version}`,
    });
    logActivity({
      action: "website.version_promoted",
      leadId,
      websiteVersionId: promoted.projectId,
      jobId: controller.jobId,
      metadata: { version: promoted.version },
    });

    return toResult(promoted, lead.businessName);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error instanceof JobStoppedError) throw error;
    const record = getWebsiteVersion(version.projectId);
    if (record && !["failed", "stopped", "current", "ready"].includes(record.status)) {
      markWebsiteVersionFailed(version.projectId, { stage: "flow", reason: errorMessage(error) });
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Website build failed.";
}

function toResult(
  version: WebsiteVersionRow,
  businessName: string,
): WebsiteProjectFlowResult {
  const currentProject = findProjectRecord(version.leadId);
  return {
    projectId: version.projectId,
    websiteProjectId: version.websiteProjectId ?? version.leadId,
    leadId: version.leadId,
    version: version.version,
    status: version.status,
    workspaceId: version.workspaceId ?? "",
    artifactHash: version.artifactHash ?? null,
    buildStatus: version.buildStatus ?? null,
    qaStatus: version.qaStatus ?? null,
    businessName,
    currentVersion: currentProject.currentVersion,
  };
}