import type {
  Agent,
  AgentContext,
  AgentLoopState,
  AgentObservation,
  AgentAction,
  AgentVerification,
  AgentVerificationCheck,
} from "./types";
import { randomUUID } from "node:crypto";
import type { TaskPlanner } from "./types";

const LOGICAL_STEPS = [
  { id: "prepare", label: "Preparing" },
  { id: "generate", label: "Generating" },
  { id: "verify-build", label: "Verifying build" },
  { id: "finish", label: "Finishing" },
];

/**
 * A deterministic planner for the sanity agent. Produces the same plan
 * regardless of goal content, so tests and the UI get predictable behaviour.
 */
function makeVerificationFromChecks(
  iteration: number,
  checks: Array<{ requirement: string; passed: boolean; detail?: string }>,
): AgentVerification {
  return {
    id: randomUUID(),
    iteration,
    passed: checks.every((c) => c.passed),
    checks,
    at: new Date().toISOString(),
  };
}

const SANITY_PLANNER: TaskPlanner = {
  plan(input) {
    return {
      objective: input.goal,
      constraints: [],
      acceptanceCriteria: [
        "Every planned step completed",
        "No errors in history",
      ],
      steps: [...LOGICAL_STEPS],
      allowedActions: ["noop"],
      verificationRequirements: ["Complete all planned steps"],
      maxIterations: 6,
    };
  },
};

/**
 * Built-in runnable agent that exercises the loop framework end-to-end
 * without touching the file system, network or any external system.
 *
 * One planned step completes per iteration. Verification passes once every
 * step is in the completed list. This guarantees a successful multi-iteration
 * run in exactly `steps.length` iterations.
 *
 * The agent is registered with "read" permission only so the permission gate
 * is exercised without granting any sensitive capability.
 */
const sanityAgent: Agent = {
  id: "loop-sanity",
  name: "Loop Sanity Agent",
  description:
    "Internal demo agent that exercises the iterative loop framework without side effects.",
  jobType: "agent_loop_sanity",
  permissions: ["read"],
  tools: [
    {
      name: "noop",
      description: "No-op tool for exercising the toolbox and permission gate.",
      permission: "read",
      execute: (input?: unknown) => ({
        acknowledged: true,
        echo: input ?? null,
        at: new Date().toISOString(),
      }),
    },
  ],
  planner: SANITY_PLANNER,

  plan() {
    return SANITY_PLANNER.plan({ goal: "Sanity check" });
  },

  inspect(
    _context: AgentContext,
    state: AgentLoopState,
  ): AgentObservation {
    return {
      id: crypto.randomUUID(),
      iteration: state.iteration,
      description: `Current step: ${state.currentStepLabel ?? "(none)"}; completed ${state.completedSteps.length}/${state.steps.length}`,
      state: { completedSteps: state.completedSteps },
      at: new Date().toISOString(),
    };
  },

  decide(
    _context: AgentContext,
    state: AgentLoopState,
  ): AgentAction {
    const stepIndex = LOGICAL_STEPS.findIndex(
      (s) => s.id === state.currentStepId,
    );
    const nextStep = LOGICAL_STEPS[stepIndex + 1] ?? null;
    return {
      name: "noop",
      permission: "read",
      description: state.currentStepLabel
        ? `Working on ${state.currentStepLabel}`
        : "No-op step",
      completesStep: true,
      nextStepId: nextStep?.id ?? null,
    };
  },

  verify(
    _context: AgentContext,
    state: AgentLoopState,
  ): AgentVerification {
    const hasError = state.errors.length > 0;
    const checks: AgentVerificationCheck[] = [
      {
        requirement: "All steps completed",
        passed: state.completedSteps.length === LOGICAL_STEPS.length,
        detail: `Completed ${state.completedSteps.length} of ${LOGICAL_STEPS.length} steps`,
      },
      {
        requirement: "No errors in history",
        passed: !hasError,
        detail: hasError ? `${state.errors.length} errors found` : undefined,
      },
    ];
    return makeVerificationFromChecks(state.iteration, checks);
  },
};

export { sanityAgent };
export type { Agent };