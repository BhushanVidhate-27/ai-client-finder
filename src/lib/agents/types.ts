/**
 * Core types for the reusable agent orchestration framework.
 *
 * An agent receives a Goal, Context, Constraints, Tools, Acceptance Criteria
 * and Loop Configuration, then repeatedly inspects state, decides an action,
 * executes it, observes the result, and verifies the outcome until it passes
 * acceptance criteria, hits a loop limit, times out, or is stopped.
 *
 * Nothing here is website-specific.
 */

import type { AgentPermission } from "./permissions";

// ---------------------------------------------------------------------------
// Goal / context
// ---------------------------------------------------------------------------

export interface AgentGoal {
  description: string;
  acceptanceCriteria: string[];
}

export interface AgentContext {
  goal: AgentGoal;
  constraints?: string[];
  /** Structured reference material (e.g. research output) passed to the agent. */
  references?: Record<string, unknown>;
  jobId?: string | null;
  campaignId?: string | null;
  leadId?: string | null;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tools / actions
// ---------------------------------------------------------------------------

/**
 * A capability an agent may invoke. Step 9 defines the interface; real
 * implementations (read/write files, run a build, inspect a website, deploy)
 * are plugged in later behind explicit permissions. Nothing here executes
 * arbitrary shell commands or deploys.
 */
export interface AgentTool {
  name: string;
  description: string;
  permission: AgentPermission;
  execute?(input: unknown, context: AgentContext): Promise<unknown> | unknown;
}

export interface AgentAction {
  /** Name of the tool to invoke. */
  name: string;
  /** Permission category required to run it. */
  permission: AgentPermission;
  input?: unknown;
  /** Human-readable label for progress/activity reporting. */
  description?: string;
  /** Mark the current planned step as completed when the action succeeds. */
  completesStep?: boolean;
  /** Advance to this planned step after a successful action. */
  nextStepId?: string | null;
}

export interface AgentActionResult {
  ok: boolean;
  description?: string;
  data?: unknown;
  error?: string;
}

export type AgentActionStatus = "succeeded" | "failed" | "rejected";

export interface AgentActionRecord {
  id: string;
  name: string;
  permission: AgentPermission;
  stepId: string | null;
  iteration: number;
  status: AgentActionStatus;
  description?: string;
  error?: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Observations / verification
// ---------------------------------------------------------------------------

export interface AgentObservation {
  id: string;
  iteration: number;
  description: string;
  state?: Record<string, unknown>;
  at: string;
}

export interface AgentVerificationCheck {
  requirement: string;
  passed: boolean;
  detail?: string;
}

export interface AgentVerification {
  id: string;
  iteration: number;
  passed: boolean;
  checks: AgentVerificationCheck[];
  at: string;
}

export interface AgentLoopError {
  iteration: number;
  stepId: string | null;
  message: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Planner output
// ---------------------------------------------------------------------------

export interface AgentStep {
  id: string;
  label: string;
}

/**
 * Structured plan produced by a TaskPlanner. It is data, not a giant
 * natural-language prompt: the agent/loop consumes the ordered steps,
 * constraints, criteria and limits directly.
 */
export interface AgentTask {
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  steps: AgentStep[];
  /** Declarative list of actions the agent is allowed to consider. */
  allowedActions: string[];
  verificationRequirements: string[];
  maxIterations: number;
}

export interface AgentPlannerInput {
  goal: string;
  constraints?: string[];
  context?: Record<string, unknown>;
}

export interface TaskPlanner {
  plan(input: AgentPlannerInput): Promise<AgentTask> | AgentTask;
}

// ---------------------------------------------------------------------------
// Loop execution state (agent memory)
//
// This is execution state, not long-term conversational AI memory. It is the
// structured source of truth for one loop run and is persisted through the
// existing job/activity history.
// ---------------------------------------------------------------------------

export interface AgentLoopState {
  iteration: number;
  maxIterations: number;
  goal: string;
  steps: AgentStep[];
  currentStepId: string | null;
  currentStepLabel: string | null;
  observations: AgentObservation[];
  actions: AgentActionRecord[];
  verificationResults: AgentVerification[];
  errors: AgentLoopError[];
  completedSteps: string[];
  progress: number;
  startedAt: string;
  lastCheckpointAt: string;
}

export type AgentResultStatus = "completed" | "failed" | "stopped";

export interface AgentResult<TResult = unknown> {
  status: AgentResultStatus;
  iteration: number;
  maxIterations: number;
  currentStepId: string | null;
  currentStepLabel: string | null;
  completedSteps: string[];
  progress: number;
  result: TResult | null;
  error: string | null;
  history: AgentLoopState;
}

// ---------------------------------------------------------------------------
// Loop configuration
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  /** Hard cap on iterations; overrides the planner default when set. */
  maxIterations?: number | null;
  /** Overall wall-clock budget in milliseconds; null/0 disables it. */
  timeoutMs?: number | null;
  /** Permissions granted to this run; defaults to the agent's declared set. */
  toolPermissions?: AgentPermission[];
}

/** Discrete milestone reported via the loop's onMilestone hook. */
export type AgentLoopMilestone =
  | "planning"
  | "iteration_started"
  | "inspection"
  | "action_started"
  | "action_succeeded"
  | "action_failed"
  | "action_rejected"
  | "verification"
  | "iteration_completed"
  | "completed"
  | "failed"
  | "stopped";

// ---------------------------------------------------------------------------
// The agent contract
//
// An agent is policy: it plans, inspects, decides and verifies. Tools (the
// toolbox) are mechanism and are always permission-gated. An agent never
// declares "I am finished" on its own word — the loop only completes when
// verification passes.
// ---------------------------------------------------------------------------

export interface Agent {
  id: string;
  name: string;
  description: string;
  /** Aligns with the existing job system type so job records tie back. */
  jobType: string;
  /** The permissions this agent is designed to use. */
  permissions: AgentPermission[];
  /** Tools the agent may invoke through the loop's toolbox. */
  tools?: AgentTool[];
  /** Optional goal -> structured task planner. Falls back to a default. */
  planner?: TaskPlanner;
  plan(context: AgentContext): Promise<AgentTask> | AgentTask;
  inspect(
    context: AgentContext,
    state: AgentLoopState,
  ): Promise<AgentObservation> | AgentObservation;
  decide(
    context: AgentContext,
    state: AgentLoopState,
    observation: AgentObservation,
  ): Promise<AgentAction> | AgentAction;
  verify(
    context: AgentContext,
    state: AgentLoopState,
    result: AgentActionResult,
  ): Promise<AgentVerification> | AgentVerification;
}