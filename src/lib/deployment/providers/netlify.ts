import type { HostingProviderAdapter } from "@/lib/deployment/adapter";
import {
  readDeploymentConfig,
  ENV_NETLIFY_TOKEN,
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

/** Optional server-side identifier of the Netlify site to deploy into. */
export const ENV_NETLIFY_SITE_ID = "NETLIFY_SITE_ID";

const API_BASE = "https://api.netlify.com/api/v1";

interface NetlifyDeploymentResponse {
  id: string;
  state?: string | null;
  url?: string | null;
  deploy_ssl_url?: string | null;
}

function mapState(state: string | null | undefined): DeploymentStatus {
  switch (String(state ?? "").toLowerCase()) {
    case "ready":
      return "ready";
    case "error":
    case "partially_deployed":
      return "failed";
    case "building":
      return "building";
    case "uploading":
    case "uploaded":
      return "uploading";
    case "deploying":
    case "processing":
      return "deploying";
    default:
      return "uploading";
  }
}

function publicUrl(response: NetlifyDeploymentResponse): string | null {
  const host = response.deploy_ssl_url ?? response.url;
  return typeof host === "string" && host.length > 0
    ? /^https?:\/\//.test(host)
      ? host
      : `https://${host}`
    : null;
}

/**
 * Netlify adapter (Step 13).
 *
 * Authentication uses NETLIFY_TOKEN server-side and the target site comes from
 * the optional NETLIFY_SITE_ID server configuration — never from the client.
 * Without a token nothing fires and the adapter reports "not configured".
 */
export class NetlifyDeploymentAdapter implements HostingProviderAdapter {
  readonly providerId: DeploymentProviderId = "netlify";
  readonly providerLabel = "Netlify";
  readonly isMock = false;
  readonly supportsCancel = false;

  validateConnection(): Promise<ProviderConnectionResult> {
    const config = readDeploymentConfig();
    if (!config.netlifyToken) {
      return Promise.resolve({
        state: "not_configured",
        message: `${this.providerLabel} is not configured (${ENV_NETLIFY_TOKEN} is unset).`,
      });
    }
    return safeFetchJson<Record<string, unknown>>(`${API_BASE}/user`, {
      headers: { Authorization: `Bearer ${config.netlifyToken}` },
    })
      .then(() => ({ state: "connected" as const, message: `${this.providerLabel} is connected.` }))
      .catch(() => ({ state: "error" as const, message: `${this.providerLabel} connection failed.` }));
  }

  async deploy(request: ProviderDeploymentRequest): Promise<ProviderDeploymentHandle> {
    const config = readDeploymentConfig();
    if (!config.netlifyToken) throw new DeploymentNotConfiguredError(this.providerLabel);
    const siteId = process.env[ENV_NETLIFY_SITE_ID];
    if (!siteId) {
      throw new DeploymentProviderError(
        this.providerLabel,
        `deployment target is not configured (${ENV_NETLIFY_SITE_ID} is unset).`,
      );
    }

    const files = Object.fromEntries(
      request.artifact.files.map((file) => [file.path, file.content]),
    );
    const response = await safeFetchJson<NetlifyDeploymentResponse>(
      `${API_BASE}/sites/${siteId}/deploys`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${config.netlifyToken}` },
        body: JSON.stringify({ files }),
      },
    );

    const status = mapState(response.state);
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
      url: publicUrl(response),
    };
  }

  async getDeploymentStatus(
    handle: ProviderDeploymentHandle,
  ): Promise<ProviderDeploymentSnapshot> {
    const config = readDeploymentConfig();
    if (!config.netlifyToken) throw new DeploymentNotConfiguredError(this.providerLabel);

    const response = await safeFetchJson<NetlifyDeploymentResponse>(
      `${API_BASE}/deploys/${handle.providerDeploymentId}`,
      {
        headers: { Authorization: `Bearer ${config.netlifyToken}` },
      },
    );
    return {
      providerDeploymentId: handle.providerDeploymentId,
      status: mapState(response.state),
      url: publicUrl(response),
      message: null,
    };
  }

  async cancelDeployment(
    handle: ProviderDeploymentHandle | null,
  ): Promise<ProviderCancelResult> {
    void handle;
    return {
      providerDeploymentId: handle?.providerDeploymentId ?? "",
      cancelled: false,
      message:
        `${this.providerLabel} does not support cancelling an in-flight deployment; ` +
        "the local attempt is marked cancelled.",
    };
  }

  async getDeploymentUrl(
    handle: ProviderDeploymentHandle,
  ): Promise<string | null> {
    const snapshot = await this.getDeploymentStatus(handle);
    return snapshot.url;
  }
}