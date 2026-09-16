import { generateWebsite } from "@/lib/website-builder";
import { createWebsiteVersion } from "@/lib/data/websites";
import { updateJob } from "@/lib/data/jobs";
import { logActivity } from "@/lib/data/activity";
import type { WebsiteProject } from "@/lib/website-project";
import type { JobController } from "@/lib/jobs/controller";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import type { QualifiedLead } from "@/lib/lead-qualification";
import type { WebsiteResearch } from "@/lib/lead-research";

export interface WebsiteFlowResult {
  project: WebsiteProject;
  projectId: string;
  version: number;
}

/**
 * Runs the full website generation (AI blueprint -> rendered files) for a
 * lead, with stop checkpoints before generation, after generation, and before
 * the job is marked complete. A stop request between any two checkpoints
 * throws JobStoppedError so that nothing is persisted and the job ends in the
 * stopped state instead of completed.
 */
export async function runWebsiteGeneration({
  leadId,
  lead,
  contact,
  research,
  controller,
}: {
  leadId: string;
  lead: QualifiedLead;
  contact: ContactDiscovery | null;
  research: WebsiteResearch;
  controller: JobController;
}): Promise<WebsiteFlowResult> {
  await controller.checkpoint();
  updateJob(controller.jobId, { progress: 10, currentStep: "generating website" });

  const generation = await generateWebsite({ lead, contact, research });

  if (generation.status === "failed" || !generation.project) {
    throw new Error(generation.errorMessage ?? "Website generation failed.");
  }

  // Between generation and persistence: a stop here prevents the version row
  // from being written at all.
  await controller.checkpoint();

  const versionRecord = createWebsiteVersion(leadId, generation.project);
  logActivity({
    action: "website.version_created",
    leadId,
    websiteVersionId: versionRecord.projectId,
    metadata: { version: versionRecord.version },
  });

  // Between persistence and job completion: persistence is already durable,
  // so stopping here still yields a correct, replayable result.
  await controller.checkpoint();
  updateJob(controller.jobId, {
    progress: 100,
    currentStep: `created v${versionRecord.version}`,
  });

  return {
    project: generation.project,
    projectId: versionRecord.projectId,
    version: versionRecord.version,
  };
}