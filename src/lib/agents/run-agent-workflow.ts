/**
 * Glue that runs an agent loop on top of the existing JobController / job
 * persistence infrastructure (runJob). The loop is started through `runJob`
 * so that it inherits the existing durable job state, cooperative pause/resume
 * and stop mechanics, and activity logging — there is no second job system.
 */

import { runJob } from "@/lib/jobs/run-job";
import { JobStoppedError } from "@/lib/jobs/controller";
import { updateJob, updateJobMetadata } from "@/lib/data/jobs";
import { logActivity } from "@/lib/data/activity";
import { getAgent } from "./registry";
import { runAgentLoop } from "./loop-engine";
import type {
  AgentContext,
  AgentLoopMilestone,
  AgentLoopState,
  AgentResult,
} from "./types";
import type { AgentPermission } from "./permissions";

export class AgentExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentExecutionError";
  }
}

export interface RunAgentWorkflowInput {
  agentId: string;
  goal: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  references?: Record<string, unknown>;
  campaignId?: string | null;
  leadId?: string | null;
  metadata?: Record<string, unknown>;
  options?: {
    timeoutMs?: number | null;
    maxIterations?: number | null;
    toolPermissions?: AgentPermission[];
  };
}

function milestoneActivityAction(milestone: AgentLoopMilestone): string {
  return `agent.${milestone}`;
}

function persistMilestone(
  milestone: AgentLoopMilestone,
  state: AgentLoopState,
  deps: {
    jobId: string;
    campaignId?: string | null;
    leadId?: string | null;
    agentId: string;
    agentName: string;
    agentJobType: string;
  },
): void {
  const progress = Math.min(99, state.progress);
  const currentStep = state.currentStepLabel ?? state.currentStepId ?? milestone;

  // Keep the job row updated so the UI has fresh currentStep / progress.
  updateJob(deps.jobId, { progress, currentStep });

  // Persist a compact agent summary in the job metadata so the UI can show
  // iteration / maxIterations without a second query. Only small scalar
  // values are written — full history lives in the activity log.
  updateJobMetadata(deps.jobId, {
    agent: {
      id: deps.agentId,
      name: deps.agentName,
      jobType: deps.agentJobType,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      progress: state.progress,
      currentStep,
      milestone,
    },
  });

  logActivity({
    action: milestoneActivityAction(milestone),
    jobId: deps.jobId,
    campaignId: deps.campaignId ?? null,
    leadId: deps.leadId ?? null,
    metadata: {
      agentId: deps.agentId,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      step: currentStep,
    },
  });
}

/**
 * Runs an agent loop through `runJob` (awaited) and returns the jobId so the
 * caller can track or redirect to the job detail view. The loop runs inline
 * — the existing controller registry keeps it accessible to the /stop and
 * /pause APIs even while the HTTP request is in-flight.
 */
export async function runAgentWorkflow(
  input: RunAgentWorkflowInput,
): Promise<{ jobId: string; result: AgentResult }> {
  const def = getAgent(input.agentId);
  if (!def) {
    throw new AgentExecutionError(
      `Agent "${input.agentId}" is not registered.`,
    );
  }
  if (!def.runner) {
    throw new AgentExecutionError(
      `Agent "${input.agentId}" is not runnable.`,
    );
  }

  const agent = def.runner;
  const context: AgentContext = {
    goal: {
      description: input.goal,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
    },
    constraints: input.constraints,
    references: input.references,
    jobId: null,
    campaignId: input.campaignId ?? null,
    leadId: input.leadId ?? null,
    metadata: input.metadata,
  };

  const outcome = await runJob(
    {
      type: def.jobType,
      campaignId: context.campaignId,
      leadId: context.leadId,
      metadata: { agentId: def.id, ...input.metadata },
    },
    async (controller) => {
      context.jobId = controller.jobId;
      let finalResult: AgentResult;

      try {
        finalResult = await runAgentLoop({
          agent,
          context,
          config: {
            maxIterations: input.options?.maxIterations ?? undefined,
            timeoutMs: input.options?.timeoutMs ?? undefined,
            toolPermissions: input.options?.toolPermissions,
          },
          controller,
          onMilestone: (milestone, state) =>
            persistMilestone(milestone, state, {
              jobId: controller.jobId,
              campaignId: context.campaignId,
              leadId: context.leadId,
              agentId: def.id,
              agentName: def.name,
              agentJobType: def.jobType,
            }),
        });
      } catch (error) {
        if (error instanceof JobStoppedError) throw error;
        const message =
          error instanceof Error ? error.message : "Agent loop failed unexpectedly.";
        throw new AgentExecutionError(message);
      }

      // runJob treats any returned value as success. We must translate
      // non-completed statuses back to thrown errors so runJob transitions the
      // job to the correct terminal state (stopped / failed).
      controller.assertNotStopped();
      if (finalResult.status === "stopped") throw new JobStoppedError();
      if (finalResult.status === "failed") {
        throw new AgentExecutionError(
          finalResult.error ?? "Agent execution failed.",
        );
      }
      return finalResult;
    },
  );

  return { jobId: outcome.jobId, result: outcome.result };
}