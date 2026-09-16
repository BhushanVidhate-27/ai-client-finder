import type {
  DeploymentOutcome,
  DeploymentRecord,
  DeploymentRequest,
  DeploymentStatus,
  FailureMode,
  LogEntry,
  PrototypeDeploymentProvider,
  ProviderConnection,
  ProviderId,
  ScriptedStep,
  WebsiteInfo,
} from "./types";

/**
 * The local provider adapter contract.
 *
 * This is the boundary the whole prototype is built around: the UI and the
 * session hook only ever talk to `DeploymentProviderAdapter`, never to a
 * provider specially. Swapping a mock adapter for a real integration means
 * implementing this interface and nothing else.
 *
 * Every method returns a typed `AdapterResult<T>` instead of throwing, so
 * failure paths (expired session, rejected deploy, missing record) are part of
 * the contract rather than exceptions. `simulated: true` is stamped on every
 * result so mock data can never be mistaken for a real provider response.
 */

export type AdapterErrorCode =
  | "not_connected"
  | "auth_required"
  | "build_failed"
  | "deployment_failed"
  | "cancelled"
  | "rate_limited"
  | "not_found"
  | "unavailable"
  | "unknown";

export interface AdapterError {
  code: AdapterErrorCode;
  message: string;
  /** Whether the UI should offer Retry rather than sending the user to Connect. */
  retryable: boolean;
}

export type AdapterResult<T> =
  | { ok: true; simulated: true; data: T }
  | { ok: false; simulated: true; error: AdapterError };

/** What a provider adapter can do. Drives which controls the UI offers. */
export interface ProviderCapabilities {
  canDeploy: boolean;
  canRedeploy: boolean;
  canStop: boolean;
  supportsCustomDomain: boolean;
}

/** Result of a simulated `connect` / authentication handshake. */
export interface AuthHandshakeResult {
  /** Narration streamed to the console while the handshake runs. */
  steps: ScriptedStep[];
  /** Connection shown mid-handshake (the "authentication required" state). */
  pending: ProviderConnection;
  /** Connection when the handshake completes. */
  result: ProviderConnection;
  succeeded: boolean;
}

/** Result of a simulated `disconnect`. */
export interface DisconnectResult {
  steps: ScriptedStep[];
  connection: ProviderConnection;
}

/** Everything the UI needs to run one deployment end to end. */
export interface DeploymentRunPlan {
  runId: string;
  /** Deployment record this run produces. */
  deploymentId: string;
  request: DeploymentRequest;
  providerLabel: string;
  publicUrl: string | null;
  /** Output streamed while the run progresses. */
  steps: ScriptedStep[];
  /** Output streamed after the user presses Stop. */
  stopSteps: ScriptedStep[];
  /** Outcome if every step completes (ignored when Stop is pressed). */
  expectedOutcome: DeploymentOutcome;
  /** Simulated total duration, used for the history entry. */
  durationMs: number;
  /** Non-null when this run was produced by the demo failure injection. */
  injectedFailure: FailureMode | null;
}

/** Point-in-time view of a run, the provider's answer to "where is it now?". */
export interface DeploymentStatusSnapshot {
  runId: string;
  deploymentId: string;
  status: DeploymentStatus;
  publicUrl: string | null;
  note: string | null;
  updatedAt: string;
}

/** Context the session hands to `stop` so the provider can record what happened. */
export interface StopContext {
  logs?: LogEntry[];
  durationMs?: number;
}

/** The provider adapter. One implementation per hosting provider. */
export interface DeploymentProviderAdapter {
  readonly providerId: ProviderId;
  readonly providerLabel: string;
  /** Label shown in the console header, e.g. "Vercel adapter (simulated)". */
  readonly adapterLabel: string;
  readonly capabilities: ProviderCapabilities;

  // --- authentication -----------------------------------------------------
  getConnectionState(): Promise<AdapterResult<ProviderConnection>>;
  connect(): Promise<AdapterResult<AuthHandshakeResult>>;
  disconnect(): Promise<AdapterResult<DisconnectResult>>;

  // --- deployment ---------------------------------------------------------
  deploy(request: DeploymentRequest): Promise<AdapterResult<DeploymentRunPlan>>;
  redeploy(request: DeploymentRequest): Promise<AdapterResult<DeploymentRunPlan>>;
  stop(runId: string, context: StopContext): Promise<AdapterResult<DeploymentOutcome>>;
  getDeploymentStatus(runId: string): Promise<AdapterResult<DeploymentStatusSnapshot>>;

  // --- reads --------------------------------------------------------------
  getWebsite(): Promise<AdapterResult<WebsiteInfo>>;
  getLogs(deploymentId: string): Promise<AdapterResult<LogEntry[]>>;
  getDeploymentHistory(projectId: string): Promise<AdapterResult<DeploymentRecord[]>>;
  getPublicUrl(deploymentId?: string): Promise<AdapterResult<string | null>>;

  // --- console ------------------------------------------------------------
  /** Opening lines for the simulated console; a real adapter returns none. */
  getSessionIntro(): Promise<AdapterResult<LogEntry[]>>;

  // --- bookkeeping --------------------------------------------------------
  /** Persists what the UI streamed. A real adapter would receive its own logs. */
  reportRunResult(
    runId: string,
    result: { outcome: DeploymentOutcome; logs: LogEntry[] },
  ): Promise<AdapterResult<DeploymentRecord>>;
}

/** Demo-only failure injection shared by every adapter. */
export interface SimulationHarness {
  /** Mode the next provider operation should fail with. */
  nextFailure(): FailureMode;
  /** Called by an adapter once the injected failure has been baked into a run. */
  reportFailureConsumed(mode: FailureMode): void;
}

export interface MutableSimulationHarness extends SimulationHarness {
  arm(mode: FailureMode): void;
  current(): FailureMode;
}

/**
 * In-memory failure injector.
 *
 * Held by the prototype client (not by React state) so adapters always read the
 * live value, and armed modes are one-shot: they clear themselves once an
 * operation has used them, which is what makes Retry meaningful.
 */
export function createSimulationHarness(): MutableSimulationHarness {
  let mode: FailureMode = "none";

  return {
    arm(next: FailureMode) {
      mode = next;
    },
    current() {
      return mode;
    },
    nextFailure() {
      return mode;
    },
    reportFailureConsumed(consumed: FailureMode) {
      if (mode === consumed) mode = "none";
    },
  };
}

/** Registry the UI reads providers and adapters from. */
export interface ProviderAdapterRegistry {
  listProviders(): PrototypeDeploymentProvider[];
  listAdapters(): DeploymentProviderAdapter[];
  getAdapter(providerId: ProviderId): DeploymentProviderAdapter | null;
  /** Adapters available for switching right now. */
  availableProviderIds(): ProviderId[];
}
