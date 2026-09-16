import type {
  AgentPlannerInput,
  AgentStep,
  AgentTask,
  TaskPlanner,
} from "./types";

export const DEFAULT_MAX_ITERATIONS = 8;

const WEBSITE_STEPS: AgentStep[] = [
  { id: "prepare-project", label: "Preparing project" },
  { id: "implement-pages", label: "Implementing pages" },
  { id: "implement-styling", label: "Implementing styling" },
  { id: "build", label: "Building" },
  { id: "inspect-build", label: "Inspecting build" },
  { id: "fix-failures", label: "Fixing failures" },
  { id: "verify-requirements", label: "Verifying requirements" },
  { id: "finish", label: "Finishing" },
];

const GENERIC_STEPS: AgentStep[] = [
  { id: "prepare", label: "Preparing" },
  { id: "implement", label: "Implementing" },
  { id: "validate", label: "Validating" },
  { id: "verify", label: "Verifying" },
  { id: "finish", label: "Finishing" },
];

function clampIterations(steps: AgentStep[]): number {
  return Math.max(DEFAULT_MAX_ITERATIONS, steps.length);
}

/**
 * Deterministic planner that turns a high-level goal into structured,
 * ordered tasks without an LLM. It intentionally never solves the goal — it
 * only produces the objective, constraints, acceptance criteria, ordered
 * steps, allowed actions and limits that the loop consumes.
 *
 * Agents that need richer plans can provide their own TaskPlanner.
 */
export class RuleBasedPlanner implements TaskPlanner {
  private pickSteps(goal: string): AgentStep[] {
    const normalized = goal.toLowerCase();
    if (
      normalized.includes("website") ||
      normalized.includes("site") ||
      normalized.includes("web page")
    ) {
      return WEBSITE_STEPS;
    }
    return GENERIC_STEPS;
  }

  plan(input: AgentPlannerInput): AgentTask {
    const steps = this.pickSteps(input.goal);
    return {
      objective: input.goal,
      constraints: input.constraints ?? [],
      acceptanceCriteria: [
        "All planned steps completed",
        "No unrecoverable errors remain",
        input.goal.trim() ? `Verified goal: ${input.goal.trim()}` : "",
      ].filter(Boolean),
      steps,
      allowedActions: ["readFile", "writeFile", "editFile", "runCommand"],
      verificationRequirements: [
        "Every planned step completed",
        "No unhandled failures in the final iteration",
      ],
      maxIterations: clampIterations(steps),
    };
  }
}

export const defaultTaskPlanner: TaskPlanner = new RuleBasedPlanner();