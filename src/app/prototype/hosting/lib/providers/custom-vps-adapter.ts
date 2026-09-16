import type { SimulationHarness } from "../../provider-contract";
import { SimulatedProviderAdapter, type SimulatedProviderConfig } from "./base-provider-adapter";

const DAY = 24 * 60 * 60 * 1000;

const config: Omit<SimulatedProviderConfig, "harness"> = {
  providerId: "custom-vps",
  providerLabel: "Custom / VPS",
  voice: {
    label: "Custom / VPS",
    binary: "deploy",
    deployCommand: "./scripts/publish.sh production",
    cliVersion: "publish hook v1.4.0 (simulated)",
    uploadLabel: "Sending build output to your target",
    authCommand: "./scripts/connect-host.sh",
    routeCount: 12,
  },
  capabilities: {
    canDeploy: true,
    canRedeploy: true,
    // Deliberate capability gap: this adapter cannot cancel a run in flight, so
    // the UI has to hide Stop and explain why.
    canStop: false,
    supportsCustomDomain: true,
  },
  initialConnection: { state: "connected", scopes: ["publish"] },
  accountLabel: "deploy@brightside-dental.example.test",
  version: 1,
  seedDeployments: [
    { version: 1, status: "live", failure: null, ageMs: 3 * DAY, note: "Current live version." },
  ],
};

export function createCustomVpsAdapter(harness: SimulationHarness): SimulatedProviderAdapter {
  return new SimulatedProviderAdapter({ ...config, harness });
}
