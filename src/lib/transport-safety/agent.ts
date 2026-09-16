import type {
  Agent,
  AgentAction,
  AgentContext,
  AgentLoopState,
  AgentObservation,
  AgentVerification,
} from "@/lib/agents/types";
import { evaluateTransportSafety } from "@/lib/transport-safety/engine";
import type {
  TransportSafetyInput,
  TransportSafetyOptions,
} from "@/lib/transport-safety/types";

const TRANSPORT_SAFETY_STEPS = [
  { id: "evaluate", label: "Evaluate transport safety" },
  { id: "verify", label: "Verify decision is intent only" },
];

export interface TransportSafetyAgentDeps {
  input?: TransportSafetyInput;
  options?: TransportSafetyOptions;
}

/**
 * Agent 10 — Transport Safety.
 *
 * Reuses the existing agent framework but holds only `read` permission: it can
 * evaluate whether an exact outreach may be marked ready for transport, and it
 * can NEVER deploy, write, execute shell commands, or contact any email
 * provider. Its output is intent only — `execute` is always false.
 */
export function createTransportSafetyAgent(
  deps: TransportSafetyAgentDeps = {},
): Agent {
  const input = deps.input;
  const options = deps.options;

  const evaluateImpl = () => {
    if (!input) {
      throw new Error("Transport safety evaluation input is missing.");
    }
    return evaluateTransportSafety(input, options ?? {});
  };

  return {
    id: "transport-safety",
    name: "Transport Safety Agent",
    description:
      "Determines whether an exact outreach may be marked READY_FOR_TRANSPORT. Never sends anything and never contacts any email provider.",
    jobType: "transport_safety",
    permissions: ["read"],
    tools: [
      {
        name: "transport.evaluate",
        description:
          "Evaluates the transport safety decision (TRANSPORT_READY | WAIT | REJECT | SKIP_PROSPECT) for an exact outreach. Never sends anything.",
        permission: "read",
        execute: evaluateImpl,
      },
    ],
    planner: {
      plan: () => ({
        objective:
          "Evaluate whether the exact outreach may be marked ready for transport.",
        constraints: [
          "Never send an email or contact any messaging provider.",
          "The evaluation is deterministic and derived only from trusted application state.",
          "execute must always remain false.",
        ],
        acceptanceCriteria: [
          "A structured TransportResult is produced.",
          "execute in the result is false.",
        ],
        steps: [...TRANSPORT_SAFETY_STEPS],
        allowedActions: ["transport.evaluate"],
        verificationRequirements: ["Decision recorded; execute is false"],
        maxIterations: 3,
      }),
    },
    plan: () => ({
      objective:
        "Evaluate whether the exact outreach may be marked ready for transport.",
      constraints: [
        "Never send an email or contact any messaging provider.",
        "The evaluation is deterministic and derived only from trusted application state.",
        "execute must always remain false.",
      ],
      acceptanceCriteria: [
        "A structured TransportResult is produced.",
        "execute in the result is false.",
      ],
      steps: [...TRANSPORT_SAFETY_STEPS],
      allowedActions: ["transport.evaluate"],
      verificationRequirements: ["Decision recorded; execute is false"],
      maxIterations: 3,
    }),

    inspect(
      _context: AgentContext,
      state: AgentLoopState,
    ): AgentObservation {
      return {
        id: `obs-transport-${state.iteration}`,
        iteration: state.iteration,
        description: `Evaluating transport safety for the exact outreach${
          input ? ` (prospect ${input.leadId})` : ""
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
        name: "transport.evaluate",
        permission: "read",
        description: `Evaluate the exact outreach against all transport safety gates (iteration ${state.iteration}).`,
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
        id: `ver-transport-${Date.now()}`,
        iteration: 0,
        passed: produced && executeFalse,
        checks: [
          {
            requirement: "A structured transport result was produced",
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