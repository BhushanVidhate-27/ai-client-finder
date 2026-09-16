import { runAgentLoop } from "@/lib/agents/loop-engine";
import { JobController, JobStoppedError } from "@/lib/jobs/controller";
import { updateJob } from "@/lib/data/jobs";
import { logActivity } from "@/lib/data/activity";
import {
  createDeploymentRecord,
  updateDeploymentRecord,
  markDeploymentFailed,
  getDeploymentRecord,
  isActiveDeploymentStatus,
} from "@/lib/data/deployments";
import {
  verifyVersionEligible,
  packageDeployment,
  pollDeploymentUntilTerminal,
} from "@/lib/deployment/service";
import {
  getDefaultDeploymentRegistry,
  type DeploymentProviderRegistry,
} from "@/lib/deployment/registry";
import type {
  DeploymentStatus,
  DeploymentProviderId,
  ProviderDeploymentHandle,
  ProviderDeploymentSnapshot,
} from "@/lib/deployment/types";
import { createWebsiteDeployerAgent } from "@/lib/website-deployer/agent";
import type { Agent } from "@/lib/agents/types";

export interface DeploymentFlowInput {
  leadId: string;
  provider: DeploymentProviderId;
  versionId?: string;
  controller: JobController;
}

export interface DeploymentFlowOptions {
  registry?: DeploymentProviderRegistry;
  deployerAgent?: Agent;
}

export interface DeploymentFlowResult {
  deploymentId: string;
  leadId: string;
  provider: DeploymentProviderId;
  status: DeploymentStatus;
  deploymentUrl: string | null;
  providerDeploymentId: string | null;
  artifactHash: string;
  version: number;
}

const STATUS_CHAIN: DeploymentStatus[] = [
  "pending",
  "validating",
  "uploading",
  "building",
  "deploying",
  "ready",
];

/**
 * Advances a record through the legal status chain to the given target so the
 * DB stays in sync with provider progress. Only single-hop legal transitions
 * are used, so this never violates the transition map.
 */
function advanceDeploymentStatusTo(
  deploymentId: string,
  target: DeploymentStatus,
): void {
  const record = getDeploymentRecord(deploymentId);
  if (!record) return;
  const from = STATUS_CHAIN.indexOf(record.status);
  const to = STATUS_CHAIN.indexOf(target);
  for (let i = from + 1; i <= to && i < STATUS_CHAIN.length; i += 1) {
    const next = STATUS_CHAIN[i];
    if (next === "ready") break;
    updateDeploymentRecord(deploymentId, { status: next });
  }
}

/**
 * Runs the Step 13 hosting deployment flow for a verified website version.
 *
 *   verify eligibility -> package artifact -> create record (pending) ->
 *   validate connection -> deploy via agent loop -> poll -> mark ready
 *
 * A stopped run marks the deployment as cancelled; a failed run marks it as
 * failed. Both propagate through the job system exactly like website-project
 * flow.
 */
export async function runWebsiteDeployment(
  input: DeploymentFlowInput,
  options: DeploymentFlowOptions = {},
): Promise<DeploymentFlowResult> {
  const { leadId, provider, controller } = input;
  const registry = options.registry ?? getDefaultDeploymentRegistry();

  const adapter = registry.getAdapter(provider);
  if (!adapter) {
    throw new Error(`Unknown hosting provider "${provider}".`);
  }

  await controller.checkpoint();

  // Stage 1 — server-side eligibility verification (trusted only).
  updateJob(controller.jobId, { progress: 5, currentStep: "verifying deployment eligibility" });
  const eligibility = await verifyVersionEligible(leadId, input.versionId);
  updateJob(controller.jobId, {
    progress: 15,
    currentStep: `v${eligibility.version} eligible, packaging artifact`,
  });

  // Stage 2 — deterministic artifact packaging (read-only workspace scan).
  const artifact = await packageDeployment(eligibility.workspaceId);
  updateJob(controller.jobId, {
    progress: 25,
    currentStep: `packaged ${artifact.files.length} files (hash ${artifact.hash.slice(0, 12)}…)`,
  });

  await controller.checkpoint();

  // Stage 3 — create deployment record (pending, with active-guard).
  const deployment = createDeploymentRecord({
    websiteProjectId: eligibility.websiteProjectId,
    leadId: eligibility.leadId,
    websiteVersionId: eligibility.versionId,
    version: eligibility.version,
    provider,
    artifactHash: artifact.hash,
    jobId: controller.jobId,
  });
  logActivity({
    action: "deployment.created",
    leadId,
    jobId: controller.jobId,
    metadata: { deploymentId: deployment.id, provider, version: eligibility.version },
  });

  // Build the deployer agent closure state.
  const state = {
    handle: null as ProviderDeploymentHandle | null,
    artifact,
    deploymentId: deployment.id,
    workspaceId: eligibility.workspaceId,
    websiteProjectId: eligibility.websiteProjectId,
    storedArtifactHash: eligibility.artifactHash,
    latestSnapshot: null as ProviderDeploymentSnapshot | null,
  };

  try {
    // Stage 4 — validate provider connection before starting the loop.
    updateDeploymentRecord(deployment.id, { status: "validating" });
    const connection = await adapter.validateConnection();
    if (connection.state !== "connected") {
      throw new Error(`Provider connection failed: ${connection.message}`);
    }
    updateJob(controller.jobId, { progress: 30, currentStep: "provider connection verified" });

    // Stage 5 — deploy via agent loop.
    updateDeploymentRecord(deployment.id, { status: "uploading" });
    updateJob(controller.jobId, { progress: 35, currentStep: `deploying to ${adapter.providerLabel}` });

    const deployerAgent = options.deployerAgent ?? createWebsiteDeployerAgent({ adapter, state });

    const loop = await runAgentLoop({
      agent: deployerAgent,
      context: {
        goal: {
          description: `Deploy the verified website artifact to ${adapter.providerLabel}.`,
          acceptanceCriteria: [
            "Provider reports deployment ready with a public URL.",
            "Workspace source hash is unchanged.",
          ],
        },
        constraints: [
          "Never write to the website workspace.",
          "All provider calls are read-only except the initial deploy.",
        ],
        references: {
          provider,
          deploymentId: deployment.id,
          artifactHash: artifact.hash,
          workspaceId: eligibility.workspaceId,
        },
      },
      config: { maxIterations: 10 },
      controller,
    });

    if (loop.status === "stopped") {
      // User or system requested a stop — attempt provider-side cancellation.
      updateDeploymentRecord(deployment.id, { status: "cancelled" });
      updateJob(controller.jobId, { progress: 40, currentStep: "deployment cancelled" });
      logActivity({
        action: "deployment.cancelled",
        leadId,
        jobId: controller.jobId,
        metadata: { deploymentId: deployment.id, provider },
      });
      if (state.handle && adapter.supportsCancel) {
        await adapter.cancelDeployment(state.handle).catch(() => {});
      }
      throw new JobStoppedError();
    }

    if (loop.status !== "completed") {
      const reason = loop.error ?? "Deployment agent failed.";
      if (state.latestSnapshot && isActiveDeploymentStatus(state.latestSnapshot.status)) {
        advanceDeploymentStatusTo(deployment.id, state.latestSnapshot.status);
      }
      markDeploymentFailed(deployment.id, reason);
      updateJob(controller.jobId, { progress: 40, currentStep: `deployment failed: ${reason}` });
      throw new Error(reason);
    }

    // Sync the DB status to the latest provider snapshot so history stays legible.
    if (state.latestSnapshot && isActiveDeploymentStatus(state.latestSnapshot.status)) {
      advanceDeploymentStatusTo(deployment.id, state.latestSnapshot.status);
    }

    // Stage 6 — agent loop completed; poll for terminal status.
    if (state.latestSnapshot?.status === "ready" && state.latestSnapshot.url) {
      // Already at terminal; no poll needed.
    } else if (state.handle) {
      updateJob(controller.jobId, { progress: 70, currentStep: "polling deployment status" });
      const terminal = await pollDeploymentUntilTerminal(adapter, state.handle);
      state.latestSnapshot = {
        providerDeploymentId: state.handle.providerDeploymentId,
        ...terminal,
      };
    }

    const finalSnapshot = state.latestSnapshot;
    if (finalSnapshot?.status === "ready" && finalSnapshot.url) {
      advanceDeploymentStatusTo(deployment.id, "deploying");
      updateDeploymentRecord(deployment.id, {
        status: "ready",
        deploymentUrl: finalSnapshot.url,
        providerDeploymentId: state.handle?.providerDeploymentId ?? null,
      });
      updateJob(controller.jobId, { progress: 100, currentStep: "deployment ready" });
      logActivity({
        action: "deployment.ready",
        leadId,
        jobId: controller.jobId,
        metadata: {
          deploymentId: deployment.id,
          provider,
          url: finalSnapshot.url,
          providerDeploymentId: state.handle?.providerDeploymentId ?? null,
        },
      });
    } else {
      const reason = finalSnapshot?.message ?? "Provider did not report a ready deployment.";
      markDeploymentFailed(deployment.id, reason);
      updateJob(controller.jobId, { progress: 40, currentStep: `deployment failed: ${reason}` });
      throw new Error(reason);
    }

    return {
      deploymentId: deployment.id,
      leadId,
      provider,
      status: "ready",
      deploymentUrl: finalSnapshot!.url,
      providerDeploymentId: state.handle?.providerDeploymentId ?? null,
      artifactHash: artifact.hash,
      version: eligibility.version,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error instanceof JobStoppedError) throw error;
    const row = getDeploymentRecord(deployment.id);
    if (row && !["ready", "failed", "cancelled"].includes(row.status)) {
      markDeploymentFailed(deployment.id, errorMessage(error));
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Deployment failed.";
}