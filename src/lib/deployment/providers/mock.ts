import { randomUUID } from "node:crypto";
import type { HostingProviderAdapter } from "@/lib/deployment/adapter";
import { readDeploymentConfig, type DeploymentConfig } from "@/lib/deployment/config";
import { MockProviderDisabledError } from "@/lib/deployment/errors";
import type {
  DeploymentProviderId,
  DeploymentStatus,
  ProviderConnectionResult,
  ProviderCancelResult,
  ProviderDeploymentHandle,
  ProviderDeploymentRequest,
  ProviderDeploymentSnapshot,
} from "@/lib/deployment/types";

/** Reserved mock-only domain; never a real deployment endpoint. */
export const MOCK_DEPLOYMENT_DOMAIN = "example.test";

const DEFAULT_SEQUENCE: DeploymentStatus[] = [
  "uploading",
  "building",
  "deploying",
  "ready",
];

export interface MockDeploymentRecord {
  providerDeploymentId: string;
  request: ProviderDeploymentRequest;
  url: string | null;
  cancelled: boolean;
}

export interface MockProviderAdapterOptions {
  /** Statuses advanced on each getDeploymentStatus call (default reaches ready). */
  sequence?: DeploymentStatus[];
  /** URL returned once the sequence reaches "ready". */
  url?: string | null;
  /** Config used to decide whether mock mode is enabled (default: env). */
  config?: DeploymentConfig;
}

function isTerminal(status: DeploymentStatus): boolean {
  return status === "ready" || status === "failed" || status === "cancelled";
}

/**
 * Deterministic mock hosting provider for development and tests.
 *
 * Registered only when MOCK_DEPLOYMENTS=1. Every artifact is clearly stamped
 * mock (provider `mock`, URLs on the reserved `*.example.test` domain, `isMock`
 * true), so a mock deploy can never be mistaken for a real public deployment.
 * Always "connected", supports cancellation, and records everything it receives
 * so tests can assert the exact artifact and that nothing was mutated.
 */
export class MockProviderAdapter implements HostingProviderAdapter {
  readonly providerId: DeploymentProviderId = "mock";
  readonly providerLabel = "Mock";
  readonly isMock = true;
  readonly supportsCancel = true;

  private readonly sequence: DeploymentStatus[];
  private readonly url: string | null;
  private readonly config: DeploymentConfig;
  private readonly runs = new Map<string, { step: number; request: ProviderDeploymentRequest }>();
  readonly deployments: MockDeploymentRecord[] = [];
  readonly cancelled: string[] = [];

  constructor(options: MockProviderAdapterOptions = {}) {
    this.config = options.config ?? readDeploymentConfig();
    this.sequence = options.sequence ?? [...DEFAULT_SEQUENCE];
    this.url = options.url ?? null;
  }

  validateConnection(): Promise<ProviderConnectionResult> {
    if (!this.config.mockEnabled) {
      return Promise.resolve({
        state: "not_configured",
        message: "Mock provider is disabled (set MOCK_DEPLOYMENTS=1 to enable).",
      });
    }
    return Promise.resolve({
      state: "connected",
      message: "Mock provider is connected (mock mode — not a real deployment).",
    });
  }

  assertEnabled(): void {
    if (!this.config.mockEnabled) throw new MockProviderDisabledError();
  }

  async deploy(request: ProviderDeploymentRequest): Promise<ProviderDeploymentHandle> {
    this.assertEnabled();

    const providerDeploymentId = `mock_${randomUUID().slice(0, 13)}`;
    const first = this.sequence[0] ?? "ready";
    this.runs.set(providerDeploymentId, { step: 0, request });
    this.deployments.push({
      providerDeploymentId,
      request,
      url: null,
      cancelled: false,
    });
    return {
      providerDeploymentId,
      status: first,
      url: null,
      providerRef: "mock-project",
    };
  }

  async getDeploymentStatus(
    handle: ProviderDeploymentHandle,
  ): Promise<ProviderDeploymentSnapshot> {
    this.assertEnabled();
    const run = this.runs.get(handle.providerDeploymentId);
    if (!run) {
      return {
        providerDeploymentId: handle.providerDeploymentId,
        status: "failed",
        url: null,
        message: "Unknown mock run.",
      };
    }
    const status = this.sequence[run.step] ?? this.sequence[this.sequence.length - 1];
    if (!isTerminal(status)) {
      run.step += 1;
    }
    const url =
      status === "ready" && this.url
        ? this.url
        : status === "ready"
          ? `https://${handle.providerDeploymentId}.${MOCK_DEPLOYMENT_DOMAIN}`
          : null;
    const record = this.deployments.find((d) => d.providerDeploymentId === handle.providerDeploymentId);
    if (record && status === "ready") record.url = url;
    return {
      providerDeploymentId: handle.providerDeploymentId,
      status,
      url,
      message: status === "ready" ? "Mock deployment is live (mock)." : null,
    };
  }

  async cancelDeployment(
    handle: ProviderDeploymentHandle | null,
  ): Promise<ProviderCancelResult> {
    this.assertEnabled();
    if (!handle) {
      return { providerDeploymentId: "", cancelled: false, message: "No provider run to cancel." };
    }
    if (!this.cancelled.includes(handle.providerDeploymentId)) {
      this.cancelled.push(handle.providerDeploymentId);
    }
    return {
      providerDeploymentId: handle.providerDeploymentId,
      cancelled: true,
      message: "Mock deployment cancelled.",
    };
  }

  async getDeploymentUrl(
    handle: ProviderDeploymentHandle,
  ): Promise<string | null> {
    const snapshot = await this.getDeploymentStatus(handle);
    return snapshot.url;
  }
}