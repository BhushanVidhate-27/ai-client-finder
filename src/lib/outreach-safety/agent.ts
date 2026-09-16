import type {
  Agent,
  AgentAction,
  AgentContext,
  AgentLoopState,
  AgentObservation,
  AgentVerification,
} from "@/lib/agents/types";
import { evaluateSendSafety } from "@/lib/outreach-safety/safety";
import type { SafetyEvaluationInput, SafetyEvaluationOptions } from "@/lib/outreach-safety/types";

const OUTREACH_SAFETY_STEPS = [
  { id: "evaluate", label: "Evaluate send safety" },
  { id: "verify", label: "Verify decision is safe intent only" },
];

export interface OutreachSafetyAgentDeps {
  input?: SafetyEvaluationInput;
  options?: SafetyEvaluationOptions;
}

/**
 * Agent 8 — Outreach Send Safety.
 *
 * Reuses the existing agent framework but holds only `read` permission: it can
 * evaluate whether an exact draft is safe and authorized to be sent, and it can
 * NEVER deploy, write, execute shell commands, or contact any external
 * messaging provider. Its output is intent only — `execute` is always false.
 */
export function createOutreachSafetyAgent(
  deps: OutreachSafetyAgentDeps = {},
): Agent {
  const input = deps.input;
  const options = deps.options;

  const evaluateImpl = () => {
    if (!input) {
      throw new Error("Outreach safety evaluation input is missing.");
    }
    return evaluateSendSafety(input, options ?? {});
  };

  return {
    id: "outreach-safety",
    name: "Outreach Send Safety Agent",
    description:
      "Determines whether an exact outreach draft is safe and authorized to send. Never sends anything.",
    jobType: "outreach_safety",
    permissions: ["read"],
    tools: [
      {
        name: "safety.evaluate",
        description:
          "Evaluates the safety decision (SEND | WAIT_FOR_APPROVAL | WAIT | REJECT | SKIP_PROSPECT) for an exact draft. Never sends anything.",
        permission: "read",
        execute: evaluateImpl,
      },
    ],
    planner: {
      plan: () => ({
        objective:
          "Evaluate whether the exact outreach draft is safe and authorized to be sent.",
        constraints: [
          "Never send an email or contact any messaging provider.",
          "The evaluation is deterministic and derived only from trusted application state.",
          "execute must always remain false.",
        ],
        acceptanceCriteria: [
          "A structured OutreachSafetyResult is produced.",
          "execute in the result is false.",
        ],
        steps: [...OUTREACH_SAFETY_STEPS],
        allowedActions: ["safety.evaluate"],
        verificationRequirements: ["Decision recorded; execute is false"],
        maxIterations: 3,
      }),
    },
    plan: () => ({
      objective:
        "Evaluate whether the exact outreach draft is safe and authorized to be sent.",
      constraints: [
        "Never send an email or contact any messaging provider.",
        "The evaluation is deterministic and derived only from trusted application state.",
        "execute must always remain false.",
      ],
      acceptanceCriteria: [
        "A structured OutreachSafetyResult is produced.",
        "execute in the result is false.",
      ],
      steps: [...OUTREACH_SAFETY_STEPS],
      allowedActions: ["safety.evaluate"],
      verificationRequirements: ["Decision recorded; execute is false"],
      maxIterations: 3,
    }),

    inspect(
      _context: AgentContext,
      state: AgentLoopState,
    ): AgentObservation {
      return {
        id: `obs-safety-${state.iteration}`,
        iteration: state.iteration,
        description: `Evaluating send safety for the exact outreach draft${
          input ? ` (prospect ${input.leadId}, draft ${input.draftId})` : ""
        }.`,
        state: input ? (input as unknown as Record<string, unknown>) : {},
        at: new Date().toISOString(),
      };
    },

    decide(
      _context: AgentContext,
      state: AgentLoopState,
    ): AgentAction {
      return {
        name: "safety.evaluate",
        permission: "read",
        description: `Evaluate the exact outreach draft against all safety gates (iteration ${state.iteration}).`,
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
        | { decision?: string; execute?: boolean }
        | null
        | undefined;
      const produced = Boolean(result.ok && data);
      const executeFalse = produced ? data?.execute === false : false;
      return {
        id: `ver-safety-${Date.now()}`,
        iteration: 0,
        passed: produced && executeFalse,
        checks: [
          {
            requirement: "A structured safety result was produced",
            passed: produced,
          },
          {
            requirement: "execute is false (intent only)",
            passed: executeFalse,
            detail: executeFalse ? undefined : "execute must always be false.",
          },
        ],
        at: new Date().toISOString(),
      };
    },
  };
}