import type { SimulationHarness } from "../../provider-contract";
import { SimulatedProviderAdapter, type SimulatedProviderConfig } from "./base-provider-adapter";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const config: Omit<SimulatedProviderConfig, "harness"> = {
  providerId: "vercel",
  providerLabel: "Vercel",
  voice: {
    label: "Vercel",
    binary: "vercel",
    deployCommand: "vercel deploy --prod --yes",
    cliVersion: "Vercel CLI 39.1.0",
    uploadLabel: "Uploading build output",
    authCommand: "vercel login",
    routeCount: 12,
  },
  capabilities: {
    canDeploy: true,
    canRedeploy: true,
    canStop: true,
    supportsCustomDomain: true,
  },
  // Starts connected with real history, so Deploy and Redeploy are both reachable.
  initialConnection: { state: "connected", scopes: ["deployments:write", "projects:read"] },
  accountLabel: "brightside-dental (team)",
  version: 3,
  seedDeployments: [
    { version: 3, status: "live", failure: null, ageMs: 2 * HOUR, note: "Current live version." },
    {
      version: 2,
      status: "failed",
      failure: "build",
      ageMs: 1 * DAY,
      note: "Build failed for v2 — v1 stayed live.",
    },
    { version: 1, status: "live", failure: null, ageMs: 4 * DAY, note: "Superseded by v3." },
  ],
};

export function createVercelAdapter(harness: SimulationHarness): SimulatedProviderAdapter {
  return new SimulatedProviderAdapter({ ...config, harness });
}
