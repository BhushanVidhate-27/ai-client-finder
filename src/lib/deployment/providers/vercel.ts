import type { HostingProviderAdapter } from "@/lib/deployment/adapter";
import {
  readDeploymentConfig,
  ENV_VERCEL_TOKEN,
} from "@/lib/deployment/config";
import {
  DeploymentNotConfiguredError,
  DeploymentProviderError,
} from "@/lib/deployment/errors";
import type {
  DeploymentProviderId,
  DeploymentStatus,
  ProviderConnectionResult,
  ProviderCancelResult,
  ProviderDeploymentHandle,
  ProviderDeploymentRequest,
  ProviderDeploymentSnapshot,
} from "@/lib/deployment/types";
import { safeFetchJson } from "@/lib/deployment/providers/http";

const API_BASE = "https://api.vercel.com";

interface VercelDeploymentResponse {
  id: string;
  url?: string | null;
  readyState?: string | null;
  status?: string | null;
}

function mapReadyState(state: string | null | undefined): DeploymentStatus {
  switch (String(state ?? "").toUpperCase()) {
    case "READY":
      return "ready";
    case "ERROR":
      return "failed";
    case "CANCELED":
    case "CANCELING":
      return "cancelled";
    case "BUILDING":
      return "building";
    case "DEPLOYING":
      return "deploying";
    default:
      return "uploading";
  }
}

function publicUrl(host: string | null | undefined): string | null {
  return typeof host === "string" && host.length > 0 ? `https://${host}` : null;
}

/**
 * Vercel adapter (Step 13).
 *
 * Endpoint is fixed; auth uses VERCEL_TOKEN server-side; the artifact sent is
 * exactly the server-verified package. Without a token nothing fires and the
 * adapter is reported "not configured" — never a fake success.
 */
export class VercelDeploymentAdapter implements HostingProviderAdapter {
  readonly providerId: DeploymentProviderId = "vercel";
  readonly providerLabel = "Vercel";
  readonly isMock = false;
  readonly supportsCancel = true;

  validateConnection(): Promise<ProviderConnectionResult> {
    const config = readDeploymentConfig();
    if (!config.vercelToken) {
      return Promise.resolve({
        state: "not_configured",
        message: `${this.providerLabel} is not configured (${ENV_VERCEL_TOKEN} is unset).`,
      });
    }
    return safeFetchJson<Record<string, unknown>>(`${API_BASE}/v2/user`, {
      headers: { Authorization: `Bearer ${config.vercelToken}` },
    })
      .then(() => ({ state: "connected" as const, message: `${this.providerLabel} is connected.` }))
      .catch(() => ({ state: "error" as const, message: `${this.providerLabel} connection failed.` }));
  }

  async deploy(request: ProviderDeploymentRequest): Promise<ProviderDeploymentHandle> {
    const config = readDeploymentConfig();
    if (!config.vercelToken) throw new DeploymentNotConfiguredError(this.providerLabel);

    const body = {
      name: request.websiteProjectId,
      files: request.artifact.files.map((file) => ({
        file: file.path,
        data: file.content,
      })),
    };
    const response = await safeFetchJson<VercelDeploymentResponse>(
      `${API_BASE}/v13/deployments`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${config.vercelToken}` },
        body: JSON.stringify(body),
      },
    );

    const status = mapReadyState(response.readyState ?? response.status);
    if (status === "failed") {
      throw new DeploymentProviderError(
        this.providerLabel,
        "deployment was rejected by the provider.",
      );
    }
    if (!response.id) {
      throw new DeploymentProviderError(
        this.providerLabel,
        "deployment was created without an id.",
      );
    }
    return {
      providerDeploymentId: response.id,
      status: status === "ready" ? "deploying" : status,
      url: publicUrl(response.url),
    };
  }

  async getDeploymentStatus(
    handle: ProviderDeploymentHandle,
  ): Promise<ProviderDeploymentSnapshot> {
    const config = readDeploymentConfig();
    if (!config.vercelToken) throw new DeploymentNotConfiguredError(this.providerLabel);

    const response = await safeFetchJson<VercelDeploymentResponse>(
      `${API_BASE}/v13/deployments/${handle.providerDeploymentId}`,
      {
        headers: { Authorization: `Bearer ${config.vercelToken}` },
      },
    );
    return {
      providerDeploymentId: handle.providerDeploymentId,
      status: mapReadyState(response.readyState ?? response.status),
      url: publicUrl(response.url),
      message: null,
    };
  }

  async cancelDeployment(
    handle: ProviderDeploymentHandle | null,
  ): Promise<ProviderCancelResult> {
    const config = readDeploymentConfig();
    if (!config.vercelToken) throw new DeploymentNotConfiguredError(this.providerLabel);
    if (!handle) {
      return { providerDeploymentId: "", cancelled: false, message: "No provider run to cancel." };
    }
    await safeFetchJson<Record<string, unknown>>(
      `${API_BASE}/v13/deployments/${handle.providerDeploymentId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.vercelToken}` },
      },
    );
    return {
      providerDeploymentId: handle.providerDeploymentId,
      cancelled: true,
      message: "Deployment cancelled at the provider.",
    };
  }

  async getDeploymentUrl(
    handle: ProviderDeploymentHandle,
  ): Promise<string | null> {
    const snapshot = await this.getDeploymentStatus(handle);
    return snapshot.url;
  }
}