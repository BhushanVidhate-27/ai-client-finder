import {
  getJob,
  tryTransitionJobStatus,
  type AgentJobRow,
} from "@/lib/data/jobs";
import { logActivity } from "@/lib/data/activity";
import {
  getLeadById,
  getLeadByPlaceId,
  toQualifiedLead,
} from "@/lib/data/leads";
import { getResearchByLeadId, upsertResearch } from "@/lib/data/research";
import { createWebsiteVersion } from "@/lib/data/websites";
import { researchLeads } from "@/lib/lead-research";
import { generateWebsite } from "@/lib/website-builder";
import {
  clearJobController,
  registerJobController,
} from "@/lib/jobs/registry";
import { JobController, JobStoppedError } from "@/lib/jobs/controller";
import type { QualifiedLead } from "@/lib/lead-qualification";
import type { ContactDiscovery } from "@/lib/contact-discovery";

/**
 * Re-runs a job that ended failed/stopped/interrupted. The caller must have
 * already claimed the job by atomically moving it to the running state (see
 * the retry route), which also prevents two simultaneous retries of the same
 * job. Executes detached from the HTTP request (fire-and-forget) and reports
 * progress through the agent_jobs record. Supported types: research and
 * website_generation.
 */
export async function retryJob(
  jobId: string,
): Promise<{ ok: boolean; error?: string }> {
  const job = getJob(jobId);
  if (!job) return { ok: false, error: "Job not found." };
  if (job.status !== "running") {
    return { ok: false, error: "Job is not in a retryable state." };
  }

  const controller = new JobController(jobId);
  registerJobController(controller);
  logActivity({ action: "job.retry_started", jobId });

  try {
    if (job.type === "research") {
      await runResearchRetry(job, controller);
      return { ok: true };
    }

    if (job.type === "website_generation" && job.leadId) {
      await runWebsiteRetry(job, controller);
      return { ok: true };
    }

    throw new Error("Retry is not supported for jobs of type " + job.type + ".");
  } catch (error) {
    if (error instanceof JobStoppedError) {
      tryTransitionJobStatus(jobId, ["running"], "stopped", {
        currentStep: "stopped",
        stoppedAt: new Date().toISOString(),
      });
      logActivity({
        action: "job.stopped",
        jobId,
        metadata: { type: job.type },
      });
      return { ok: false, error: "Job stopped during retry." };
    }
    const message = error instanceof Error ? error.message : "Retry failed.";
    tryTransitionJobStatus(jobId, ["running"], "failed", {
      currentStep: "failed",
      completedAt: new Date().toISOString(),
      error: message,
    });
    logActivity({
      action: "job.failed",
      jobId,
      metadata: { type: job.type, error: message },
    });
    return { ok: false, error: message };
  } finally {
    clearJobController(jobId);
  }
}

async function runResearchRetry(
  job: AgentJobRow,
  controller: JobController,
): Promise<void> {
  const placeIds = Array.isArray(job.metadata.placeIds)
    ? (job.metadata.placeIds as unknown[]).filter(
        (p): p is string => typeof p === "string",
      )
    : [];

  const leads: QualifiedLead[] = [];
  const contactByPlaceId = new Map<string, ContactDiscovery | null | undefined>();

  for (const placeId of placeIds) {
    const stored = getLeadByPlaceId(placeId);
    if (!stored) continue;
    leads.push(toQualifiedLead(stored));
    contactByPlaceId.set(placeId, stored.contactDiscovery);
  }

  let completed = 0;
  const total = leads.length;

  await researchLeads(leads, contactByPlaceId, 3, {
    beforeLead: async () => {
      await controller.checkpoint();
    },
    afterLead: async (lead, result) => {
      if (result.status === "complete" && result.websiteResearch) {
        const target = getLeadByPlaceId(lead.placeId);
        if (target) upsertResearch(target.id, result.websiteResearch);
      }
      completed += 1;
      tryTransitionJobStatus(job.id, ["running"], "running", {
        progress: Math.round((completed / Math.max(total, 1)) * 100),
        currentStep: "retried " + completed + " of " + total,
      });
    },
  });

  if (controller.isStopRequested) {
    throw new JobStoppedError();
  }

  tryTransitionJobStatus(job.id, ["running"], "completed", {
    progress: 100,
    currentStep: "completed",
    completedAt: new Date().toISOString(),
  });
  logActivity({ action: "job.completed", jobId: job.id, metadata: { type: job.type } });
}

async function runWebsiteRetry(
  job: AgentJobRow,
  controller: JobController,
): Promise<void> {
  const stored = getLeadById(job.leadId!);
  const researchRow = getResearchByLeadId(job.leadId!);
  if (!stored || !researchRow) {
    throw new Error("Lead or research no longer available for retry.");
  }

  const qualifiedLead = toQualifiedLead(stored);
  await controller.checkpoint();

  const generation = await generateWebsite({
    lead: qualifiedLead,
    contact: stored.contactDiscovery,
    research: researchRow.websiteResearch,
  });
  if (generation.status === "failed" || !generation.project) {
    throw new Error(generation.errorMessage ?? "Website generation failed.");
  }

  await controller.checkpoint();

  const versionRecord = createWebsiteVersion(stored.id, generation.project);
  logActivity({
    action: "website.version_created",
    leadId: stored.id,
    websiteVersionId: versionRecord.projectId,
    metadata: { version: versionRecord.version, retried: true },
  });

  tryTransitionJobStatus(job.id, ["running"], "completed", {
    progress: 100,
    currentStep: "completed v" + versionRecord.version,
    completedAt: new Date().toISOString(),
  });
  logActivity({ action: "job.completed", jobId: job.id, metadata: { type: job.type } });
}