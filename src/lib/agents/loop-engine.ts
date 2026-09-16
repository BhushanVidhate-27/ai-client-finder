import { randomUUID } from "node:crypto";
import { JobController, JobStoppedError } from "@/lib/jobs/controller";
import { PermissionError } from "./permissions";
import { defaultTaskPlanner, DEFAULT_MAX_ITERATIONS } from "./planner";
import { AgentToolbox } from "./toolbox";
import type {
  Agent,
  AgentActionResult,
  AgentActionRecord,
  AgentContext,
  AgentLoopConfig,
  AgentLoopError,
  AgentLoopMilestone,
  AgentLoopState,
  AgentResult,
  AgentVerification,
  AgentVerificationCheck,
} from "./types";

export const MAX_ITERATIONS_REASON = "Maximum agent iterations reached.";
export const TIMEOUT_REASON = "Agent execution timed out.";

class AgentTimeoutError extends Error {
  constructor() {
    super(TIMEOUT_REASON);
    this.name = "AgentTimeoutError";
  }
}

export interface RunAgentLoopInput {
  agent: Agent;
  context: AgentContext;
  config?: AgentLoopConfig;
  controller: JobController;
  /** Called at every structured milestone so the caller can persist/observe. */
  onMilestone?: (milestone: AgentLoopMilestone, state: AgentLoopState) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

function computeProgress(
  completedSteps: string[],
  steps: AgentLoopState["steps"],
): number {
  if (steps.length === 0) return 0;
  return Math.min(100, Math.round((completedSteps.length / steps.length) * 100));
}

function makeVerification(
  iteration: number,
  checks: AgentVerificationCheck[],
  at = nowIso(),
): AgentVerification {
  return {
    id: randomUUID(),
    iteration,
    passed: checks.every((check) => check.passed),
    checks,
    at,
  };
}

/**
 * Reusable iterative loop runner.
 *
 * Lifecycle per iteration:
 *
 *   checkpoint()          (pause/stop gate + durability point)
 *   inspect()             -> observation
 *   decide()              -> action
 *   toolbox.run(action)   -> result (permission-gated)
 *   observe result
 *   verify()              -> verification
 *   pass  -> complete (a final checkpoint plus a stop re-check before
 *                      reporting success, so a STOP never appears completed)
 *   fail  -> another corrective iteration
 *   limit -> fail safely
 *
 * Supports maxIterations, an overall timeout, pause/resume and stop through
 * the existing JobController, structured history, and progress reporting.
 * It can never spin forever: every path is bounded by the iteration limit and
 * every phase is recorded in `history`.
 */
export async function runAgentLoop(
  input: RunAgentLoopInput,
): Promise<AgentResult> {
  const { agent, context, config = {}, controller } = input;
  const onMilestone = input.onMilestone;

  const planner = agent.planner ?? defaultTaskPlanner;
  const task = await planner.plan({
    goal: context.goal.description,
    constraints: context.constraints ?? [],
    context: context.references,
  });

  const maxIterations =
    config.maxIterations ?? task.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const granted = config.toolPermissions ?? agent.permissions;
  const toolbox = new AgentToolbox(agent.tools ?? [], granted);
  const deadline =
    config.timeoutMs && config.timeoutMs > 0
      ? Date.now() + config.timeoutMs
      : null;

  const startedAt = nowIso();
  const state: AgentLoopState = {
    iteration: 0,
    maxIterations,
    goal: task.objective,
    steps: task.steps,
    currentStepId: task.steps[0]?.id ?? null,
    currentStepLabel: task.steps[0]?.label ?? null,
    observations: [],
    actions: [],
    verificationResults: [],
    errors: [],
    completedSteps: [],
    progress: 0,
    startedAt,
    lastCheckpointAt: startedAt,
  };

  const refreshProgress = () => {
    state.progress = computeProgress(state.completedSteps, state.steps);
  };

  const emit = (milestone: AgentLoopMilestone) => {
    state.lastCheckpointAt = nowIso();
    refreshProgress();
    onMilestone?.(milestone, state);
  };

  const checkDeadline = () => {
    if (deadline !== null && Date.now() >= deadline) {
      throw new AgentTimeoutError();
    }
  };

  const recordError = (message: string, stepId: string | null) => {
    state.errors.push({
      iteration: state.iteration,
      stepId,
      message,
      at: nowIso(),
    } satisfies AgentLoopError);
  };

  const recordAction = (
    actionName: string,
    permission: AgentActionRecord["permission"],
    stepId: string | null,
    status: AgentActionRecord["status"],
  ): AgentActionRecord => {
    const record: AgentActionRecord = {
      id: randomUUID(),
      name: actionName,
      permission,
      stepId,
      iteration: state.iteration,
      status,
      at: nowIso(),
    };
    state.actions.push(record);
    return record;
  };

  const summary = () => ({
    iteration: state.iteration,
    maxIterations,
    currentStepId: state.currentStepId,
    currentStepLabel: state.currentStepLabel,
    completedSteps: [...state.completedSteps],
    progress: state.progress,
    history: state,
  });

  const returnFailed = (reason: string): AgentResult => {
    emit("failed");
    return { status: "failed", ...summary(), result: null, error: reason };
  };

  const returnStopped = (): AgentResult => {
    emit("stopped");
    return {
      status: "stopped",
      ...summary(),
      result: null,
      error: "Agent run stopped by request.",
    };
  };

  /**
   * Runs one decided action through the permission-gated toolbox and records
   * the outcome (succeeded / failed / rejected) in the structured history.
   */
  async function runAction(decided: Awaited<ReturnType<Agent["decide"]>>): Promise<AgentActionResult> {
    const last = recordAction(decided.name, decided.permission, state.currentStepId, "succeeded");
    try {
      // Before expensive action: allow a stop to land here (or a pause to block).
      await controller.checkpoint();
      checkDeadline();
      const data = await toolbox.run(decided, context);
      last.status = "succeeded";
      last.description = decided.description;
      emit("action_succeeded");
      return { ok: true, description: decided.description, data };
    } catch (error) {
      if (error instanceof JobStoppedError) throw error;
      if (error instanceof AgentTimeoutError) throw error;
      const message = toMessage(error);
      last.status = error instanceof PermissionError ? "rejected" : "failed";
      last.error = message;
      last.description = decided.description;
      emit(last.status === "rejected" ? "action_rejected" : "action_failed");
      return { ok: false, error: message };
    }
  }

  try {
    while (state.iteration < maxIterations) {
      // Before iterating: pause blocks until resume; stop throws.
      await controller.checkpoint();
      checkDeadline();

      state.iteration += 1;
      emit("iteration_started");

      let actionWasAttempted = false;

      try {
        const observation = await agent.inspect(context, state);
        state.observations.push(observation);
        emit("inspection");

        const decided = await agent.decide(context, state, observation);
        actionWasAttempted = true;
        emit("action_started");

        const result = await runAction(decided);

        // Observe the result of the action.
        state.observations.push({
          id: randomUUID(),
          iteration: state.iteration,
          description:
            result.description ??
            (result.ok ? `${decided.name} succeeded.` : `${decided.name} failed.`),
          state: { ok: result.ok, error: result.error ?? null },
          at: nowIso(),
        });

        // Advance the plan when the action succeeded and requested so.
        if (result.ok && decided.completesStep) {
          const currentId = state.currentStepId;
          if (currentId && !state.completedSteps.includes(currentId)) {
            state.completedSteps.push(currentId);
          }
          if (decided.nextStepId) {
            const next = task.steps.find((step) => step.id === decided.nextStepId);
            if (next) {
              state.currentStepId = next.id;
              state.currentStepLabel = next.label;
            }
          }
        }

        // Verification is the only way an agent may finish.
        let verification: AgentVerification;
        try {
          await controller.checkpoint();
          checkDeadline();
          verification = await agent.verify(context, state, result);
        } catch (error) {
          if (error instanceof JobStoppedError) throw error;
          if (error instanceof AgentTimeoutError) throw error;
          const message = toMessage(error);
          recordError(message, state.currentStepId);
          verification = makeVerification(state.iteration, [
            { requirement: "verifier", passed: false, detail: message },
          ]);
        }
        state.verificationResults.push(verification);
        emit("verification");

        if (verification.passed) {
          // Final gate before completion: honors pause, and a stop requested
          // anywhere up to here means the run is stopped, never completed.
          await controller.checkpoint();
          if (controller.isStopRequested) return returnStopped();
          emit("completed");
          return {
            status: "completed",
            ...summary(),
            result: (result.data ?? null) as unknown | null,
            error: null,
          };
        }
      } catch (error) {
        if (error instanceof JobStoppedError) throw error;
        if (error instanceof AgentTimeoutError) throw error;

        // Failure before/around an action (inspect/decide/verify threw): record
        // it and continue as a corrective iteration. The iteration limit bounds
        // this forever.
        recordError(toMessage(error), state.currentStepId);
        if (actionWasAttempted) {
          const last = state.actions[state.actions.length - 1];
          if (last) {
            last.status = "failed";
            last.error = toMessage(error);
          }
        }
        emit("iteration_completed");
        continue;
      }

      // Between iterations so a stop does not start the next iteration, and
      // a pause takes effect before the next unit of work.
      await controller.checkpoint();
      checkDeadline();
      emit("iteration_completed");
    }

    return returnFailed(MAX_ITERATIONS_REASON);
  } catch (error) {
    if (error instanceof JobStoppedError) {
      return returnStopped();
    }
    if (error instanceof AgentTimeoutError) {
      return returnFailed(TIMEOUT_REASON);
    }
    throw error;
  }
}