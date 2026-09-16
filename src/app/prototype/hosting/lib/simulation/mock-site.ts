import type { WebsiteInfo } from "../../types";
import { mockProjectUrl } from "./mock-urls";

/**
 * The generated website every provider adapter is asked to publish.
 *
 * Provider-agnostic on purpose: switching providers in the prototype shows the
 * same website being targeted at different hosts.
 */
export const MOCK_BUSINESS = {
  name: "Brightside Dental Studio",
  projectId: "prj_9f3a71c4e8b2",
  leadId: "lead_2f81c0",
  campaignId: "cmp_5531",
} as const;

export function buildWebsiteInfo(input: {
  version: number;
  providerId: import("../../types").ProviderId;
  lastDeployedAt: number | null;
}): WebsiteInfo {
  const hasLiveVersion = input.lastDeployedAt !== null;

  return {
    businessName: MOCK_BUSINESS.name,
    projectId: MOCK_BUSINESS.projectId,
    leadId: MOCK_BUSINESS.leadId,
    campaignId: MOCK_BUSINESS.campaignId,
    version: input.version,
    framework: "Next.js 16 (static export)",
    buildCommand: "npm run build",
    outputDirectory: "out",
    publicUrl: hasLiveVersion ? mockProjectUrl(input.providerId) : null,
    lastDeployedAt:
      input.lastDeployedAt === null ? null : new Date(input.lastDeployedAt).toISOString(),
  };
}
