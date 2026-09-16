import type {
  AdapterErrorCode,
  AdapterResult,
  AuthHandshakeResult,
  DeploymentProviderAdapter,
  DeploymentRunPlan,
  DeploymentStatusSnapshot,
  DisconnectResult,
  ProviderCapabilities,
  SimulationHarness,
  StopContext,
} from "../../provider-contract";
import type {
  ConnectionState,
  DeploymentOutcome,
  DeploymentRecord,
  DeploymentRequest,
  FailureMode,
  LogEntry,
  ProviderConnection,
  ProviderId,
  ScriptedStep,
  WebsiteInfo,
} from "../../types";
import {
  buildConnectSteps,
  buildDeployScript,
  buildDisconnectSteps,
  buildSessionIntro,
  buildStopSteps,
  buildStoppedScript,
  logsFromSteps,
  type ProviderVoice,
} from "../simulation/lifecycle";
import { mockDeploymentUrl } from "../simulation/mock-urls";
import { buildWebsiteInfo } from "../simulation/mock-site";

/**
 * Shared behaviour for every simulated provider.
 *
 * One instance per provider, holding that provider's own connection state,
 * deployment history, and generated website. Everything is in memory: no
 * process is spawned, no socket is opened, no credential exists.
 *
 * The only bit of "harness" it knows about is the demo failure injector, which
 * it reads through `SimulationHarness` so an armed failure really is one-shot.
 */

export interface SeedDeployment {
  version: number;
  status: "live" | "failed" | "stopped";
  /** Which injected failure produced this seed (for failed runs). */
  failure: FailureMode | null;
  /** Age relative to adapter creation, in milliseconds. */
  ageMs: number;
  note: string | null;
}

export interface SimulatedProviderConfig {
  providerId: ProviderId;
  providerLabel: string;
  voice: ProviderVoice;
  capabilities: ProviderCapabilities;
  /** Connection state the provider starts in. */
  initialConnection: { state: ConnectionState; scopes: string[] };
  /** Account label that appears once connected. Never a real account. */
  accountLabel: string;
  /** Current generated website version. */
  version: number;
  /** Newest-first deployment history used to seed the prototype. */
  seedDeployments: SeedDeployment[];
  harness: SimulationHarness;
  latencyMs?: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class SimulatedProviderAdapter implements DeploymentProviderAdapter {
  readonly providerId: ProviderId;
  readonly providerLabel: string;
  readonly adapterLabel: string;
  readonly capabilities: ProviderCapabilities;

  private readonly config: SimulatedProviderConfig;
  private connection: ProviderConnection;
  private deployments: DeploymentRecord[];
  private website: WebsiteInfo;
  private readonly runs = new Map<string, DeploymentRunPlan>();
  private counter = 0;

  constructor(config: SimulatedProviderConfig) {
    this.config = config;
    this.providerId = config.providerId;
    this.providerLabel = config.providerLabel;
    this.adapterLabel = `${config.providerLabel} adapter (simulated)`;
    this.capabilities = config.capabilities;

    const now = Date.now();
    this.connection = {
      providerId: config.providerId,
      state: config.initialConnection.state,
      accountLabel:
        config.initialConnection.state === "connected" ? config.accountLabel : null,
      scopes: config.initialConnection.state === "connected" ? [...config.initialConnection.scopes] : [],
      lastCheckedAt: new Date(now - 12 * 60 * 1000).toISOString(),
    };

    this.deployments = config.seedDeployments.map((seed) => this.buildSeedRecord(seed, now));

    const live = this.deployments.find((record) => record.status === "live" && record.publicUrl);
    this.website = buildWebsiteInfo({
      version: config.version,
      providerId: config.providerId,
      lastDeployedAt: live ? new Date(live.startedAt).getTime() : null,
    });
  }

  // --- internals ----------------------------------------------------------

  private async after<T>(value: T, ms?: number): Promise<T> {
    const delay = ms ?? this.config.latencyMs ?? 220;
    return new Promise((resolve) => {
      setTimeout(() => resolve(value), delay);
    });
  }

  private ok<T>(data: T): AdapterResult<T> {
    return { ok: true, simulated: true, data };
  }

  private fail(code: AdapterErrorCode, message: string, retryable = true): AdapterResult<never> {
    return { ok: false, simulated: true, error: { code, message, retryable } };
  }

  private findRecord(deploymentId: string): DeploymentRecord | undefined {
    return this.deployments.find((record) => record.id === deploymentId);
  }

  private touchConnection(
    state: ConnectionState,
    accountLabel: string | null,
    scopes: string[],
  ): ProviderConnection {
    this.connection = {
      ...this.connection,
      state,
      accountLabel,
      scopes,
      lastCheckedAt: new Date().toISOString(),
    };
    return this.connection;
  }

  private buildSeedRecord(seed: SeedDeployment, now: number): DeploymentRecord {
    const startedAt = now - seed.ageMs;
    const url = mockDeploymentUrl(this.providerId, seed.version);

    const script =
      seed.status === "stopped"
        ? buildStoppedScript({
            voice: this.config.voice,
            providerLabel: this.providerLabel,
            version: seed.version,
          })
        : buildDeployScript({
            voice: this.config.voice,
            providerLabel: this.providerLabel,
            version: seed.version,
            url,
            failure: seed.failure ?? "none",
          });

    // Live seeds use a plausible wall-clock duration; failed and stopped seeds
    // use the scripted narration length.
    const duration = seed.status === "live" ? 62_000 : script.durationMs;

    return {
      id: `dep_${this.providerId}_v${seed.version}`,
      version: seed.version,
      providerId: this.providerId,
      status: seed.status,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(startedAt + duration).toISOString(),
      durationMs: duration,
      publicUrl: seed.status === "live" ? url : null,
      note: seed.note ?? script.expectedOutcome.note,
      logs: logsFromSteps(script.steps, startedAt),
    };
  }

  // --- authentication -----------------------------------------------------

  async getConnectionState(): Promise<AdapterResult<ProviderConnection>> {
    return this.after(this.ok(clone(this.connection)), 120);
  }

  async connect(): Promise<AdapterResult<AuthHandshakeResult>> {
    const injected = this.config.harness.nextFailure();
    const authFailure = injected === "auth";
    if (authFailure) this.config.harness.reportFailureConsumed("auth");

    const pending = this.touchConnection("auth_required", null, []);
    const succeeded = !authFailure;

    const result = succeeded
      ? this.touchConnection("connected", this.config.accountLabel, this.config.initialConnection.scopes)
      : pending;

    const steps: ScriptedStep[] = buildConnectSteps({
      voice: this.config.voice,
      providerLabel: this.providerLabel,
      accountLabel: this.config.accountLabel,
      succeeded,
    });

    return this.after(
      this.ok<AuthHandshakeResult>({
        steps,
        pending: clone(pending),
        result: clone(result),
        succeeded,
      }),
      600,
    );
  }

  async disconnect(): Promise<AdapterResult<DisconnectResult>> {
    if (this.connection.state === "not_connected") {
      return this.fail(
        "not_connected",
        `${this.providerLabel} is already disconnected.`,
        false,
      );
    }

    const connection = this.touchConnection("not_connected", null, []);
    const steps = buildDisconnectSteps({
      voice: this.config.voice,
      providerLabel: this.providerLabel,
    });

    return this.after(this.ok<DisconnectResult>({ steps, connection: clone(connection) }), 400);
  }

  // --- deployment ---------------------------------------------------------

  async deploy(request: DeploymentRequest): Promise<AdapterResult<DeploymentRunPlan>> {
    return this.createRun({ ...request, mode: "deploy" });
  }

  async redeploy(request: DeploymentRequest): Promise<AdapterResult<DeploymentRunPlan>> {
    return this.createRun({ ...request, mode: "redeploy" });
  }

  private async createRun(request: DeploymentRequest): Promise<AdapterResult<DeploymentRunPlan>> {
    if (!this.capabilities.canDeploy) {
      return this.fail("unavailable", `The ${this.providerLabel} adapter cannot deploy.`, false);
    }
    if (this.connection.state !== "connected") {
      return this.fail(
        "not_connected",
        `${this.providerLabel} is not connected. Connect the provider (simulated) before deploying.`,
        false,
      );
    }

    const injected = this.config.harness.nextFailure();
    if (injected !== "none") this.config.harness.reportFailureConsumed(injected);

    const url = mockDeploymentUrl(this.providerId, request.version);
    const script = buildDeployScript({
      voice: this.config.voice,
      providerLabel: this.providerLabel,
      version: request.version,
      url,
      failure: injected,
    });

    this.counter += 1;
    const runId = `run_${this.providerId}_${this.counter}`;
    const deploymentId = `dep_${this.providerId}_${this.counter}_v${request.version}`;

    const plan: DeploymentRunPlan = {
      runId,
      deploymentId,
      request,
      providerLabel: this.providerLabel,
      publicUrl: script.expectedOutcome.publicUrl,
      steps: script.steps,
      stopSteps: buildStopSteps(this.config.voice),
      expectedOutcome: script.expectedOutcome,
      durationMs: script.durationMs,
      injectedFailure: injected === "none" ? null : injected,
    };

    if (injected === "auth") {
      this.touchConnection("auth_required", null, []);
    }

    this.deployments.unshift({
      id: deploymentId,
      version: request.version,
      providerId: this.providerId,
      status: "preparing",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      publicUrl: null,
      note:
        request.mode === "redeploy"
          ? `Redeploying v${request.version} to ${this.providerLabel}`
          : `Deploying v${request.version} to ${this.providerLabel}`,
      logs: [],
    });

    this.runs.set(runId, plan);
    return this.after(this.ok(plan), this.config.latencyMs ?? 300);
  }

  async stop(runId: string, context: StopContext): Promise<AdapterResult<DeploymentOutcome>> {
    const plan = this.runs.get(runId);
    const record = plan ? this.findRecord(plan.deploymentId) : undefined;

    if (!plan || !record) {
      return this.fail("not_found", `No in-flight run ${runId} on ${this.providerLabel}.`, false);
    }
    if (!this.capabilities.canStop) {
      return this.fail(
        "unavailable",
        `The ${this.providerLabel} adapter cannot cancel a run in flight; it will finish or time out.`,
        false,
      );
    }

    const durationMs = context.durationMs ?? Date.now() - new Date(record.startedAt).getTime();
    const outcome: DeploymentOutcome = {
      status: "stopped",
      publicUrl: null,
      note: "Stopped by you. The previously live version is still online.",
      durationMs,
    };

    record.status = "stopped";
    record.finishedAt = new Date().toISOString();
    record.durationMs = durationMs;
    record.publicUrl = null;
    record.note = outcome.note;
    if (context.logs) record.logs = clone(context.logs);

    return this.after(this.ok(outcome), 200);
  }

  async getDeploymentStatus(runId: string): Promise<AdapterResult<DeploymentStatusSnapshot>> {
    const plan = this.runs.get(runId);
    const record = plan ? this.findRecord(plan.deploymentId) : undefined;
    if (!plan || !record) {
      return this.fail("not_found", `${this.providerLabel} has no record of run ${runId}.`, false);
    }

    return this.after(
      this.ok<DeploymentStatusSnapshot>({
        runId,
        deploymentId: record.id,
        status: record.status,
        publicUrl: record.publicUrl,
        note: record.note,
        updatedAt: new Date().toISOString(),
      }),
      140,
    );
  }

  async reportRunResult(
    runId: string,
    result: { outcome: DeploymentOutcome; logs: LogEntry[] },
  ): Promise<AdapterResult<DeploymentRecord>> {
    const plan = this.runs.get(runId);
    const record = plan ? this.findRecord(plan.deploymentId) : undefined;
    if (!plan || !record) {
      return this.fail("not_found", `${this.providerLabel} has no record of run ${runId}.`, false);
    }

    record.status = result.outcome.status;
    record.finishedAt = new Date().toISOString();
    record.durationMs = result.outcome.durationMs;
    record.publicUrl = result.outcome.publicUrl;
    record.note = result.outcome.note;
    record.logs = clone(result.logs);

    if (result.outcome.status === "live" && result.outcome.publicUrl) {
      this.website = {
        ...this.website,
        version: record.version,
        publicUrl: result.outcome.publicUrl,
        lastDeployedAt: record.finishedAt,
      };
    }

    return this.after(this.ok(clone(record)), 150);
  }

  // --- reads --------------------------------------------------------------

  async getWebsite(): Promise<AdapterResult<WebsiteInfo>> {
    return this.after(this.ok(clone(this.website)), 140);
  }

  async getLogs(deploymentId: string): Promise<AdapterResult<LogEntry[]>> {
    const record = this.findRecord(deploymentId);
    if (!record) {
      return this.fail("not_found", `${this.providerLabel} has no deployment ${deploymentId}.`, false);
    }
    return this.after(this.ok(clone(record.logs)), 120);
  }

  async getDeploymentHistory(projectId: string): Promise<AdapterResult<DeploymentRecord[]>> {
    void projectId;
    const sorted = [...this.deployments].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    return this.after(this.ok(clone(sorted)), 160);
  }

  async getPublicUrl(deploymentId?: string): Promise<AdapterResult<string | null>> {
    if (deploymentId) {
      const record = this.findRecord(deploymentId);
      if (!record) {
        return this.fail("not_found", `${this.providerLabel} has no deployment ${deploymentId}.`, false);
      }
      return this.after(this.ok<string | null>(record.publicUrl), 120);
    }

    const live = this.deployments.find((record) => record.status === "live" && record.publicUrl);
    return this.after(this.ok<string | null>(live?.publicUrl ?? null), 140);
  }

  async getSessionIntro(): Promise<AdapterResult<LogEntry[]>> {
    const lines = buildSessionIntro({
      voice: this.config.voice,
      providerLabel: this.providerLabel,
      adapterLabel: this.adapterLabel,
      connectionState: this.connection.state,
      existingDeployments: this.deployments.length,
    });
    return this.after(this.ok(lines), 80);
  }
}
