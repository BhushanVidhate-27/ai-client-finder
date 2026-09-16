import type {
  Agent,
  AgentAction,
  AgentContext,
  AgentLoopState,
  AgentObservation,
  AgentVerification,
} from "@/lib/agents/types";
import { evaluateNextAction } from "@/lib/campaign-orchestrator/evaluate";
import type {
  OrchestratorInput,
  OrchestratorOptions,
  OrchestratorResult,
} from "@/lib/campaign-orchestrator/types";

const ORCHESTRATOR_STEPS = [
  { id: "evaluate", label: "Evaluate next legal action" },
  { id: "verify", label: "Verify the decision is intent only" },
];

export interface CampaignOrchestratorAgentDeps {
  input?: OrchestratorInput;
  options?: OrchestratorOptions;
}

/**
 * Agent 9 — Campaign Orchestrator.
 *
 * Deterministic coordinator that reports the next legal action for one
 * prospect across the campaign state machine. Reuses the existing agent
 * framework but holds only `read` permission: it can evaluate, and it can
 * NEVER deploy, write, execute shell commands, or contact any external
 * provider. Its output is a decision only — `execute` is always false.
 */
export function createCampaignOrchestratorAgent(
  deps: CampaignOrchestratorAgentDeps = {},
): Agent {
  const input = deps.input;
  const options = deps.options;

  const evaluateImpl = (): OrchestratorResult => {
    if (!input) {
      throw new Error("Campaign orchestrator evaluation input is missing.");
    }
    return evaluateNextAction(input, options ?? {});
  };

  return {
    id: "campaign-orchestrator",
    name: "Campaign Orchestrator Agent",
    description:
      "Determines the next legal action in the campaign state machine for a single prospect. Never sends, deploys or executes anything.",
    jobType: "campaign_orchestration",
    permissions: ["read"],
    tools: [
      {
        name: "orchestrator.evaluate",
        description:
          "Reports the next legal campaign state (DISCOVER/QUALIFY/RESEARCH/WEBSITE/DEPLOYMENT/OUTREACH/WAIT/STOP etc.) for one prospect. Never executes anything.",
        permission: "read",
        execute: evaluateImpl,
      },
    ],
    planner: {
      plan: () => ({
        objective:
          "Determine the next legal action for this prospect within the campaign state machine.",
        constraints: [
          "Never send an email, never deploy, never write files or run shell commands.",
          "The evaluation is deterministic and derived only from trusted application state.",
          "execute must always remain false.",
        ],
        acceptanceCriteria: [
          "A structured OrchestratorResult with a valid CampaignState is produced.",
          "execute in the result is false.",
        ],
        steps: [...ORCHESTRATOR_STEPS],
        allowedActions: ["orchestrator.evaluate"],
        verificationRequirements: ["State machine decision produced; execute is false"],
        maxIterations: 3,
      }),
    },
    plan: () => ({
      objective:
        "Determine the next legal action for this prospect within the campaign state machine.",
      constraints: [
        "Never send an email, never deploy, never write files or run shell commands.",
        "The evaluation is deterministic and derived only from trusted application state.",
        "execute must always remain false.",
      ],
      acceptanceCriteria: [
        "A structured OrchestratorResult with a valid CampaignState is produced.",
        "execute in the result is false.",
      ],
      steps: [...ORCHESTRATOR_STEPS],
      allowedActions: ["orchestrator.evaluate"],
      verificationRequirements: ["State machine decision produced; execute is false"],
      maxIterations: 3,
    }),

    inspect(
      _context: AgentContext,
      state: AgentLoopState,
    ): AgentObservation {
      return {
        id: `obs-orchestrator-${state.iteration}`,
        iteration: state.iteration,
        description: `Determining the next legal action for prospect ${
          input?.leadId ?? "(unknown)"
        }.`,
        state: input
          ? (input as unknown as Record<string, unknown>)
          : {},
        at: new Date().toISOString(),
      };
    },

    decide(
      _context: AgentContext,
      state: AgentLoopState,
    ): AgentAction {
      return {
        name: "orchestrator.evaluate",
        permission: "read",
        description: `Evaluate the next legal campaign state (iteration ${state.iteration}).`,
        completesStep: true,
        nextStepId: "verify",
      };
    },

    verify(
      _context: AgentContext,
      _state: AgentLoopState,
      result: { ok: boolean; data?: unknown; error?: string },
    ): AgentVerification {
      const data = result.data as
        | { state?: string; execute?: boolean }
        | null
        | undefined;
      const produced = Boolean(result.ok && data);
      const hasState = produced ? typeof data?.state === "string" : false;
      const executeFalse = produced ? data?.execute === false : false;
      return {
        id: `ver-orchestrator-${Date.now()}`,
        iteration: 0,
        passed: produced && hasState && executeFalse,
        checks: [
          {
            requirement: "A structured state machine decision was produced",
            passed: produced && hasState,
          },
          {
            requirement: "execute is false (decision only)",
            passed: executeFalse,
            detail: executeFalse ? undefined : "execute must always be false.",
          },
        ],
        at: new Date().toISOString(),
      };
    },
  };
}