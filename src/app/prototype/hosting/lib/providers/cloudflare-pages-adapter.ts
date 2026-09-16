import type { SimulationHarness } from "../../provider-contract";
import { SimulatedProviderAdapter, type SimulatedProviderConfig } from "./base-provider-adapter";

const config: Omit<SimulatedProviderConfig, "harness"> = {
  providerId: "cloudflare-pages",
  providerLabel: "Cloudflare Pages",
  voice: {
    label: "Cloudflare Pages",
    binary: "wrangler",
    deployCommand: "wrangler pages deploy out --project-name=brightside-dental",
    cliVersion: "wrangler 4.2.0",
    uploadLabel: "Uploading to Cloudflare Pages",
    authCommand: "wrangler login",
    routeCount: 12,
  },
  capabilities: {
    canDeploy: true,
    canRedeploy: true,
    canStop: true,
    // No custom-domain handling in the simulated adapter.
    supportsCustomDomain: false,
  },
  // Nothing deployed yet and nothing connected: this is the "not deployed" path,
  // and it exercises the connect → deploy sequence from scratch.
  initialConnection: { state: "not_connected", scopes: [] },
  accountLabel: "brightside-dental.workers.dev",
  version: 1,
  seedDeployments: [],
};

export function createCloudflarePagesAdapter(
  harness: SimulationHarness,
): SimulatedProviderAdapter {
  return new SimulatedProviderAdapter({ ...config, harness });
}
