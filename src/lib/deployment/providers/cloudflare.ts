import { createHash } from "node:crypto";
import type { HostingProviderAdapter } from "@/lib/deployment/adapter";
import {
  readDeploymentConfig,
  ENV_CLOUDFLARE_API_TOKEN,
  ENV_CLOUDFLARE_ACCOUNT_ID,
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
import { assertSafeProjectId } from "@/lib/website-coding/workspace";

const API_BASE = "https://api.cloudflare.com/client/v4";

interface CloudflareResult<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T | null;
}

interface PagesDeploymentResult {
  id: string;
  url?: string | null;
  status?: string | null;
  latest_stage?: { status?: string | null } | null;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function mapStatus(status: string | null | undefined): DeploymentStatus {
  switch (String(status ?? "").toLowerCase()) {
    case "success":
    case "live":
    case "ready":
      return "ready";
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "building":
    case "processing":
      return "building";
    case "queued":
    case "uploading":
    case "upload":
      return "uploading";
    default:
      return "deploying";
  }
}

function multipartBody(
  fields: Array<{ name: string; value: string }>,
  boundary: string,
): string {
  const parts: string[] = [];
  for (const field of fields) {
    const safeName = field.name.replace(/"/g, "");
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"\r\n\r\n${field.value}\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return parts.join("");
}

/**
 * Cloudflare Pages adapter (Step 13).
 *
 * Auth uses CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID server-side. The Pages
 * project name is the (already slug-safe) website project id, never a
 * client-supplied value. Files are sent via the documented Direct Upload
 * multipart API; credentials live only on the server and are never exposed.
 */
export class CloudflarePagesDeploymentAdapter implements HostingProviderAdapter {
  readonly providerId: DeploymentProviderId = "cloudflare";
  readonly providerLabel = "Cloudflare Pages";
  readonly isMock = false;
  readonly supportsCancel = false;

  validateConnection(): Promise<ProviderConnectionResult> {
    const config = readDeploymentConfig();
    if (!config.cloudflareToken || !config.cloudflareAccountId) {
      return Promise.resolve({
        state: "not_configured",
        message:
          `${this.providerLabel} is not configured ` +
          `(${ENV_CLOUDFLARE_API_TOKEN} / ${ENV_CLOUDFLARE_ACCOUNT_ID} are unset).`,
      });
    }
    return safeFetchJson<CloudflareResult<{ id: string }>>(
      `${API_BASE}/accounts/${config.cloudflareAccountId}`,
      {
        headers: { Authorization: `Bearer ${config.cloudflareToken}` },
      },
    )
      .then((result) =>
        result.success
          ? ({ state: "connected" as const, message: `${this.providerLabel} is connected.` } as const)
          : ({ state: "error" as const, message: `${this.providerLabel} connection failed.` } as const),
      )
      .catch(() => ({ state: "error" as const, message: `${this.providerLabel} connection failed.` }));
  }

  private requireConfig() {
    const config = readDeploymentConfig();
    if (!config.cloudflareToken || !config.cloudflareAccountId) {
      throw new DeploymentNotConfiguredError(this.providerLabel);
    }
    return config;
  }

  private async ensureProject(
    config: ReturnType<typeof this.requireConfig>,
    projectName: string,
  ): Promise<void> {
    const url = `${API_BASE}/accounts/${config.cloudflareAccountId}/pages/projects`;
    const created = await safeFetchJson<CloudflareResult<PagesDeploymentResult>>(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.cloudflareToken}` },
      body: JSON.stringify({ name: projectName }),
    });
    // 409 (project exists) surfaces as HTTP error in safeFetchJson; treat any
    // non-success silently as "exists or unmodifiable" — the deployment below
    // will report the real failure.
    void created;
  }

  async deploy(request: ProviderDeploymentRequest): Promise<ProviderDeploymentHandle> {
    const config = this.requireConfig();
    const projectName = assertSafeProjectId(request.websiteProjectId);

    await this.ensureProject(config, projectName);

    const boundary = `----aicf-${Date.now()}`;
    const manifest: Record<string, string> = {};
    const fields: Array<{ name: string; value: string }> = [];
    for (const file of request.artifact.files) {
      manifest[file.path] = sha256(file.content);
      fields.push({ name: file.path, value: file.content });
    }
    fields.unshift({ name: "manifest", value: JSON.stringify(manifest) });

    const response = await safeFetchJson<CloudflareResult<PagesDeploymentResult>>(
      `${API_BASE}/accounts/${config.cloudflareAccountId}/pages/projects/${projectName}/deployments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.cloudflareToken}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: multipartBody(fields, boundary),
      },
    );

    if (!response.success || !response.result?.id) {
      throw new DeploymentProviderError(
        this.providerLabel,
        "deployment was rejected by the provider.",
      );
    }
    const status = mapStatus(response.result.status ?? response.result.latest_stage?.status);
    return {
      providerDeploymentId: response.result.id,
      providerRef: projectName,
      status: status === "ready" ? "deploying" : status,
      url:
        typeof response.result.url === "string" && response.result.url.length > 0
          ? response.result.url
          : null,
    };
  }

  async getDeploymentStatus(
    handle: ProviderDeploymentHandle,
  ): Promise<ProviderDeploymentSnapshot> {
    const config = this.requireConfig();
    const projectName = assertSafeProjectId(handle.providerRef ?? "project");

    const response = await safeFetchJson<CloudflareResult<PagesDeploymentResult>>(
      `${API_BASE}/accounts/${config.cloudflareAccountId}/pages/projects/${projectName}/deployments/${handle.providerDeploymentId}`,
      {
        headers: { Authorization: `Bearer ${config.cloudflareToken}` },
      },
    );
    const result = response.result;
    if (!response.success || !result) {
      throw new DeploymentProviderError(this.providerLabel, "deployment status unavailable.");
    }
    return {
      providerDeploymentId: handle.providerDeploymentId,
      status: mapStatus(result.status ?? result.latest_stage?.status),
      url:
        typeof result.url === "string" && result.url.length > 0 ? result.url : null,
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
        `${this.providerLabel} does not expose in-flight cancellation; ` +
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