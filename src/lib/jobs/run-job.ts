import {
  createJob,
  ensureJobStateFresh,
  tryTransitionJobStatus,
  type JobType,
} from "@/lib/data/jobs";
import { logActivity } from "@/lib/data/activity";
import {
  clearJobController,
  registerJobController,
} from "@/lib/jobs/registry";
import { JobController, JobStoppedError } from "@/lib/jobs/controller";

export interface RunJobInput {
  type: JobType | string;
  campaignId?: string | null;
  leadId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RunJobResult<T> {
  jobId: string;
  result: T;
}

export class JobStopped {
  constructor(public jobId: string) {}
}

/**
 * Wraps a unit of work in a DB-backed job record with a cooperative
 * controller. On completion the job is marked completed; on JobStoppedError it
 * is marked stopped (the work performed so far is preserved by the caller);
 * on any other error it is marked failed.
 */
export async function runJob<T>(
  input: RunJobInput,
  work: (controller: JobController) => Promise<T>,
): Promise<RunJobResult<T>> {
  // Before operating on the job store, recover jobs left running/stopping by
  // a previous process so stale work is never reported as completed.
  ensureJobStateFresh();

  const job = createJob({
    type: input.type,
    campaignId: input.campaignId ?? null,
    leadId: input.leadId ?? null,
    metadata: input.metadata ?? {},
  });
  const controller = new JobController(job.id);
  registerJobController(controller);
  const now = new Date().toISOString();
  tryTransitionJobStatus(job.id, ["queued"], "running", {
    startedAt: now,
    currentStep: "starting",
  });
  logActivity({
    action: "job.started",
    jobId: job.id,
    campaignId: input.campaignId ?? null,
    leadId: input.leadId ?? null,
    metadata: { type: input.type },
  });

  try {
    const result = await work(controller);
    tryTransitionJobStatus(job.id, ["running", "paused", "queued"], "completed", {
      progress: 100,
      currentStep: "completed",
      completedAt: new Date().toISOString(),
    });
    logActivity({
      action: "job.completed",
      jobId: job.id,
      campaignId: input.campaignId ?? null,
      leadId: input.leadId ?? null,
      metadata: { type: input.type },
    });
    return { jobId: job.id, result };
  } catch (error) {
    if (error instanceof JobStoppedError) {
      tryTransitionJobStatus(
        job.id,
        ["running", "paused", "queued"],
        "stopped",
        {
          currentStep: "stopped",
          stoppedAt: new Date().toISOString(),
        },
      );
      logActivity({
        action: "job.stopped",
        jobId: job.id,
        campaignId: input.campaignId ?? null,
        leadId: input.leadId ?? null,
        metadata: { type: input.type },
      });
      throw new JobStopped(job.id);
    }
    const message = error instanceof Error ? error.message : "Job failed.";
    tryTransitionJobStatus(
      job.id,
      ["running", "paused", "queued"],
      "failed",
      {
        currentStep: "failed",
        completedAt: new Date().toISOString(),
        error: message,
      },
    );
    logActivity({
      action: "job.failed",
      jobId: job.id,
      campaignId: input.campaignId ?? null,
      leadId: input.leadId ?? null,
      metadata: { type: input.type, error: message },
    });
    throw error;
  } finally {
    clearJobController(job.id);
  }
}