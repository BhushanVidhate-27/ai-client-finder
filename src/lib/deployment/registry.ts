import type { HostingProviderAdapter } from "@/lib/deployment/adapter";
import { readDeploymentConfig, type DeploymentConfig } from "@/lib/deployment/config";
import { VercelDeploymentAdapter } from "@/lib/deployment/providers/vercel";
import { NetlifyDeploymentAdapter } from "@/lib/deployment/providers/netlify";
import { CloudflarePagesDeploymentAdapter } from "@/lib/deployment/providers/cloudflare";
import { MockProviderAdapter } from "@/lib/deployment/providers/mock";
import type { DeploymentProviderId, ProviderConnectionResult } from "@/lib/deployment/types";

/**
 * Hosting provider adapter registry (Step 13).
 *
 * Returns only server-authorized adapters. The client never sees tokens,
 * endpoints, or raw provider configuration; it receives a safe connection
 * state per provider derived entirely from trusted server-side config.
 */
export interface DeploymentProviderRegistry {
  listProviders(): DeploymentProviderSummary[];
  getAdapter(id: DeploymentProviderId): HostingProviderAdapter | null;
  getProviderConnectionState(id: DeploymentProviderId): Promise<ProviderConnectionResult>;
}

export interface DeploymentProviderSummary {
  id: DeploymentProviderId;
  label: string;
  isMock: boolean;
  supportsCancel: boolean;
}

/**
 * Creates a registry backed by the given config (default: env). Tests can
 * inject a config or a custom adapter map directly.
 */
export function createDeploymentRegistry(
  configOverrides?: Partial<DeploymentConfig>,
  adapters?: Partial<Record<DeploymentProviderId, HostingProviderAdapter>>,
): DeploymentProviderRegistry {
  const config = configOverrides
    ? { ...readDeploymentConfig(), ...configOverrides }
    : readDeploymentConfig();

  const adaptersMap = new Map<DeploymentProviderId, HostingProviderAdapter>();

  if (adapters?.vercel) adaptersMap.set("vercel", adapters.vercel);
  else adaptersMap.set("vercel", new VercelDeploymentAdapter());

  if (adapters?.netlify) adaptersMap.set("netlify", adapters.netlify);
  else adaptersMap.set("netlify", new NetlifyDeploymentAdapter());

  if (adapters?.cloudflare) adaptersMap.set("cloudflare", adapters.cloudflare);
  else adaptersMap.set("cloudflare", new CloudflarePagesDeploymentAdapter());

  if (config.mockEnabled && adapters?.mock) {
    adaptersMap.set("mock", adapters.mock);
  } else if (config.mockEnabled) {
    adaptersMap.set("mock", new MockProviderAdapter({ config }));
  }

  return {
    listProviders() {
      return [...adaptersMap.values()].map((a) => ({
        id: a.providerId,
        label: a.providerLabel,
        isMock: a.isMock,
        supportsCancel: a.supportsCancel,
      }));
    },
    getAdapter(id: DeploymentProviderId): HostingProviderAdapter | null {
      return adaptersMap.get(id) ?? null;
    },
    async getProviderConnectionState(
      id: DeploymentProviderId,
    ): Promise<ProviderConnectionResult> {
      const adapter = adaptersMap.get(id);
      if (!adapter) {
        return { state: "not_configured", message: `Unknown provider "${id}".` };
      }
      return adapter.validateConnection();
    },
  };
}

let defaultRegistry: DeploymentProviderRegistry | null = null;

export function getDefaultDeploymentRegistry(): DeploymentProviderRegistry {
  if (!defaultRegistry) defaultRegistry = createDeploymentRegistry();
  return defaultRegistry;
}

/** Resets the default singleton; call in tests after changing env. */
export function resetDefaultDeploymentRegistry(): void {
  defaultRegistry = null;
}