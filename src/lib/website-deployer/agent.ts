import type { Agent, AgentContext, AgentLoopState, AgentObservation, AgentTask } from "@/lib/agents/types";
import type { HostingProviderAdapter } from "@/lib/deployment/adapter";
import type { DeployableArtifact, DeploymentStatus, ProviderDeploymentHandle, ProviderDeploymentSnapshot } from "@/lib/deployment/types";
import { hashWorkspace } from "@/lib/website-coding/source-hash";

const MAX_DEPLOY_ITERATIONS = 10;

export interface DeployerAgentState {
  handle: ProviderDeploymentHandle | null;
  artifact: DeployableArtifact;
  deploymentId: string;
  workspaceId: string;
  websiteProjectId: string;
  storedArtifactHash: string;
  latestSnapshot: ProviderDeploymentSnapshot | null;
}

function makeTask(): AgentTask {
  return {
    objective: "Deploy the verified, immutable website artifact to the selected hosting provider.",
    constraints: [
      "Never write to the website workspace.",
      "Only use tools that have deploy permission for the actual provider call.",
      "All status polling is bounded and returns only provider facts.",
    ],
    acceptanceCriteria: [
      "The provider reports the deployment as ready with a public URL.",
      "The website workspace was not mutated during the deployment.",
    ],
    steps: [
      { id: "deploy", label: "deploy artifact to provider" },
      { id: "poll", label: "poll deployment status" },
    ],
    allowedActions: [
      "deployment.deploy",
      "deployment.status",
      "deployment.verify_immutable",
    ],
    verificationRequirements: [
      "Provider deployment status is ready with a public URL.",
      "Artifact hash equals the approved workspace hash.",
    ],
    maxIterations: MAX_DEPLOY_ITERATIONS,
  };
}

export interface DeployerAgentDeps {
  adapter: HostingProviderAdapter;
  state: DeployerAgentState;
}

export function createWebsiteDeployerAgent(
  deps: DeployerAgentDeps,
): Agent {
  const { adapter, state } = deps;

  const inspectImpl = async (
    _context: AgentContext,
    loopState: AgentLoopState,
  ): Promise<AgentObservation> => {
    let sourceIntact = true;
    try {
      const rehash = await hashWorkspace(state.workspaceId);
      sourceIntact = rehash === state.storedArtifactHash;
    } catch {
      sourceIntact = false;
    }

    return {
      id: `obs-deploy-${loopState.iteration}`,
      iteration: loopState.iteration,
      description: sourceIntact
        ? "Source workspace is unchanged. Proceeding with deployment."
        : "Source workspace may have been modified after approval.",
      state: {
        providerId: adapter.providerId,
        providerLabel: adapter.providerLabel,
        hasHandle: state.handle !== null,
        currentStatus: state.latestSnapshot?.status ?? state.handle?.status ?? null,
        sourceIntact,
      },
      at: new Date().toISOString(),
    };
  };

  const decideImpl = (
    _context: AgentContext,
    _loopState: AgentLoopState,
    observation: AgentObservation,
  ) => {
    const obs = observation.state as Record<string, unknown>;
    const hasHandle = obs?.hasHandle === true;
    const currentStatus = obs?.currentStatus as DeploymentStatus | null;

    if (!hasHandle) {
      return {
        name: "deployment.deploy",
        permission: "deploy" as const,
        description: "Start deployment to the provider.",
        completesStep: true,
        nextStepId: "poll",
      };
    }

    if (
      currentStatus &&
      (currentStatus === "ready" || currentStatus === "failed" || currentStatus === "cancelled")
    ) {
      return {
        name: "deployment.verify_immutable",
        permission: "read" as const,
        description: "Final immutability verification.",
        completesStep: true,
        nextStepId: null,
      };
    }

    return {
      name: "deployment.status",
      permission: "read" as const,
      description: "Poll the provider for deployment progress.",
      completesStep: false,
      nextStepId: null,
    };
  };

  const verifyImpl = async () => {
    const snapshot = state.latestSnapshot;
    const ready = snapshot?.status === "ready" && Boolean(snapshot.url);
    let sourceIntact = true;
    try {
      const rehash = await hashWorkspace(state.workspaceId);
      sourceIntact = rehash === state.storedArtifactHash;
    } catch {
      sourceIntact = false;
    }

    const passed = ready && sourceIntact;
    return {
      id: `ver-deploy-${Date.now()}`,
      iteration: 0,
      passed,
      checks: [
        { requirement: "provider reports ready", passed: ready, detail: snapshot?.status ?? "unknown" },
        { requirement: "workspace source unchanged", passed: sourceIntact, detail: "hash verified" },
      ],
      at: new Date().toISOString(),
    };
  };

  return {
    id: "website-deployer",
    name: "Website Deployer Agent",
    description:
      "Deploys a verified, immutable website artifact to the configured hosting provider.",
    jobType: "deployment",
    permissions: ["read", "execute", "deploy"],
    tools: [
      {
        name: "deployment.deploy",
        description:
          "Sends the verified artifact to the provider and returns a deployment handle.",
        permission: "deploy",
        async execute(): Promise<ProviderDeploymentHandle> {
          const handle = await adapter.deploy({
            artifact: state.artifact,
            websiteProjectId: state.websiteProjectId,
            version: 1,
          });
          state.handle = handle;
          const snapshot = await adapter.getDeploymentStatus(handle).catch(() => ({
            providerDeploymentId: handle.providerDeploymentId,
            status: handle.status,
            url: handle.url,
            message: null,
          }));
          state.latestSnapshot = snapshot;
          return handle;
        },
      },
      {
        name: "deployment.status",
        description: "Returns the provider's current status for the active deployment.",
        permission: "read",
        async execute(): Promise<ProviderDeploymentSnapshot> {
          if (!state.handle) {
            throw new Error("No active deployment handle.");
          }
          const snapshot = await adapter.getDeploymentStatus(state.handle);
          state.latestSnapshot = snapshot;
          return snapshot;
        },
      },
      {
        name: "deployment.verify_immutable",
        description:
          "Verifies the workspace source hash still matches the approved artifact hash.",
        permission: "read",
        async execute(): Promise<{ unchanged: boolean; currentHash: string }> {
          try {
            const rehash = await hashWorkspace(state.workspaceId);
            return {
              unchanged: rehash === state.storedArtifactHash,
              currentHash: rehash,
            };
          } catch {
            return { unchanged: false, currentHash: "" };
          }
        },
      },
    ],
    planner: {
      plan: () => makeTask(),
    },
    plan: () => makeTask(),
    inspect: inspectImpl,
    decide: decideImpl,
    verify: verifyImpl,
  };
}

/**
 * Minimal deployer agent whose plan/inspect/decide/verify can be overridden
 * for deterministic tests of pause/stop/timeout without touching real adapters.
 */
export function createControllableDeployerAgent(
  baseDeps: DeployerAgentDeps,
  overrides: {
    onDecide?: (iteration: number) => void;
    stopOnDecide?: boolean;
  } = {},
): Agent {
  const real = createWebsiteDeployerAgent(baseDeps);

  return {
    ...real,
    plan: real.plan,
    inspect: real.inspect,
    decide(context, state, observation) {
      if (overrides.stopOnDecide) {
        return { name: "deployment.status", permission: "read" as const };
      }
      overrides.onDecide?.(state.iteration);
      return real.decide(context, state, observation);
    },
    verify: real.verify,
  };
}