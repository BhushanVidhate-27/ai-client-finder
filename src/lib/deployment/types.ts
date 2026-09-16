/**
 * Deployment abstractions (Step 9 boundary).
 *
 * The rest of the app depends only on these interfaces so that agents can
 * later be hosted on a long-running process (Node worker, Docker container,
 * VM daemon) while the Next.js server stays serverless / ephemeral. Nothing
 * here is implemented yet; this file is deliberately interface-only.
 */

/** Capabilities the outside world needs from an agent host. */
export interface DeploymentAgent {
  /** Run a job (by agent_jobs.id) detached from the HTTP request lifecycle. */
  runJobDetached(jobId: string): Promise<void>;
  /** Ask the host process to stop a running job. */
  stopJob(jobId: string): Promise<void>;
  /** Ask the host process to pause a running job. */
  pauseJob(jobId: string): Promise<void>;
  /** Ask the host process to resume a paused job. */
  resumeJob(jobId: string): Promise<void>;
}

/** A hosted compute provider (e.g. Layer0, AWS/Lambda, GCP/Cloud Run, Docker). */
export interface HostingProvider {
  readonly id: string;
  /** Persist job state so it can be resumed after an ephemeral restart. */
  persistState?(jobId: string): Promise<void>;
  /** Start a detached run for the given job on this provider. */
  startDetachedRun(jobId: string): Promise<void>;
}

/** A long-lived terminal session used to drive the browser/agents. */
export interface TerminalSession {
  readonly sessionId: string;
  run(command: string, args: string[]): Promise<string>;
  kill(): Promise<void>;
}

/** Registry of deployment providers/agents. Empty until Step 9. */
export const deploymentRegistry = {
  agents: new Map<string, DeploymentAgent>(),
  providers: new Map<string, HostingProvider>(),
  sessions: new Map<string, TerminalSession>(),
  registerAgent(id: string, agent: DeploymentAgent): void {
    deploymentRegistry.agents.set(id, agent);
  },
  registerProvider(id: string, provider: HostingProvider): void {
    deploymentRegistry.providers.set(id, provider);
  },
  registerSession(id: string, session: TerminalSession): void {
    deploymentRegistry.sessions.set(id, session);
  },
};

// ---------------------------------------------------------------------------
// Website hosting deployment (Step 13)
//
// These types describe deploying a VERIFIED website version to a hosting
// provider. They are distinct from the Step 9 "hosted compute" types above:
// `HostingProvider` is an abstraction for hosting the agent process itself,
// while `HostingProviderAdapter` below deploys generated websites.
// ---------------------------------------------------------------------------

/** Providers supported by the deployment system. */
export type DeploymentProviderId =
  | "vercel"
  | "netlify"
  | "cloudflare"
  | "mock";

/** Server-observed connection state for a provider (never exposes secrets). */
export type ProviderConnectionState =
  | "not_configured"
  | "configured"
  | "connected"
  | "error";

/**
 * Lifecycle of a deployment attempt. `pending`, `validating` and `uploading`
 * are local stages; `building`/`deploying`/`ready` echo the provider; failure
 * and cancellation are terminal. `ready` is terminal for one attempt.
 */
export type DeploymentStatus =
  | "pending"
  | "validating"
  | "uploading"
  | "building"
  | "deploying"
  | "ready"
  | "failed"
  | "cancelled";

export const DEPLOYMENT_STATUS_SET: readonly DeploymentStatus[] = [
  "pending",
  "validating",
  "uploading",
  "building",
  "deploying",
  "ready",
  "failed",
  "cancelled",
];

/** Deterministic, packaged artifact handed to a provider adapter. */
export interface DeployableArtifact {
  /** Files sorted by relative path; contents already read from the workspace. */
  files: Array<{ path: string; content: string }>;
  /** Deterministic SHA-256 over the packaged files (see source-hash). */
  hash: string;
}

/** Request a provider adapter receives to start a deployment. */
export interface ProviderDeploymentRequest {
  artifact: DeployableArtifact;
  websiteProjectId: string;
  version: number;
}

/** Handle returned by `deploy`; used to poll/status/cancel a provider run. */
export interface ProviderDeploymentHandle {
  providerDeploymentId: string;
  /** Initial provider-side status. */
  status: DeploymentStatus;
  /** Deployment URL when the provider has already assigned one. */
  url: string | null;
  /** Provider-specific reference needed to address the run (e.g. project name). */
  providerRef?: string | null;
}

/** Point-in-time provider run status. */
export interface ProviderDeploymentSnapshot {
  providerDeploymentId: string;
  status: DeploymentStatus;
  url: string | null;
  /** Safe, human-readable note; never contains secrets/source paths. */
  message: string | null;
}

export interface ProviderConnectionResult {
  state: ProviderConnectionState;
  /** Safe message, e.g. "configured" / "authenticated as …". No secret values. */
  message: string | null;
}

export interface ProviderCancelResult {
  providerDeploymentId: string;
  cancelled: boolean;
  message: string | null;
}