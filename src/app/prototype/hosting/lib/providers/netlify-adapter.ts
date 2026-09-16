import type { SimulationHarness } from "../../provider-contract";
import { SimulatedProviderAdapter, type SimulatedProviderConfig } from "./base-provider-adapter";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const config: Omit<SimulatedProviderConfig, "harness"> = {
  providerId: "netlify",
  providerLabel: "Netlify",
  voice: {
    label: "Netlify",
    binary: "netlify",
    deployCommand: "netlify deploy --prod --dir=out",
    cliVersion: "Netlify CLI 17.36.0",
    uploadLabel: "Uploading deploy directory",
    authCommand: "netlify login",
    routeCount: 12,
  },
  capabilities: {
    canDeploy: true,
    canRedeploy: true,
    canStop: true,
    supportsCustomDomain: true,
  },
  // Starts in the "authentication required" state: the connect handshake is the
  // only way to unblock deployment here.
  initialConnection: { state: "auth_required", scopes: [] },
  accountLabel: "brightside-dental",
  version: 2,
  seedDeployments: [
    { version: 2, status: "live", failure: null, ageMs: 6 * HOUR, note: "Current live version." },
    {
      version: 1,
      status: "stopped",
      failure: null,
      ageMs: 2 * DAY,
      note: "Stopped by you during the upload.",
    },
  ],
};

export function createNetlifyAdapter(harness: SimulationHarness): SimulatedProviderAdapter {
  return new SimulatedProviderAdapter({ ...config, harness });
}
