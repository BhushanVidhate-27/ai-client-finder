/**
 * Campaign Execution (Step 16) — typed contracts for the durable job runner.
 *
 * The runner is a coordinator only. It asks Agent 9 (evaluateNextAction) for
 * the next legal state of each prospect and then calls the matching existing
 * production flow with the shared JobController. It never implements an
 * agent A1–A8, never sends email and never deploys on its own authority — the
 * existing flows re-verify every permission gate before acting.
 */

import type { Lead } from "@/lib/google-places";
import type {
  QualifiedLead,
  QualifyLeadsOptions,
} from "@/lib/lead-qualification";
import type {
  ResearchHooks,
  ResearchResult,
} from "@/lib/lead-research";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import type { Agent } from "@/lib/agents/types";
import type { DeploymentProviderId } from "@/lib/deployment/types";
import type { DeploymentProviderRegistry } from "@/lib/deployment/registry";
import type { CampaignState } from "@/lib/campaign-orchestrator/types";

// ---------------------------------------------------------------------------
// Dependency-injected services (external-API steps stay injectable in tests)
// ---------------------------------------------------------------------------

export type DiscoverLeadsFn = (
  niche: string,
  location: string,
  leadCount: number,
  options?: { discoveryPool?: number },
) => Promise<Lead[]>;

export type QualifyLeadsFn = (
  niche: string,
  location: string,
  leads: Lead[],
  options?: QualifyLeadsOptions,
) => Promise<QualifiedLead[]>;

export type ResearchLeadsFn = (
  leads: QualifiedLead[],
  contactByPlaceId: Map<string, ContactDiscovery | null | undefined>,
  concurrency?: number,
  hooks?: ResearchHooks,
) => Promise<ResearchResult[]>;

/**
 * Everything the runner may reach for when executing a step. When a field is
 * omitted the production dependency is used; tests replace only the
 * external-API steps so the entire pipeline stays offline-deterministic.
 */
export interface CampaignExecutionServices {
  discoverLeads?: DiscoverLeadsFn;
  qualifyLeads?: QualifyLeadsFn;
  researchLeads?: ResearchLeadsFn;
  /** Overrides the website coding agent (deterministic offline). */
  codingAgent?: Agent;
  /** Overrides the website QA agent (deterministic offline). */
  qaAgent?: Agent;
  /** Overrides the website deployer agent. */
  deployerAgent?: Agent;
  /** Deployment registry (defaults to the env-backed singleton). */
  registry?: DeploymentProviderRegistry;
  /** Hosting provider used when a deployment step is authorized. */
  provider?: DeploymentProviderId;
  /** Passed through to the Agent 8 send-safety evaluation. */
  transportAvailable?: boolean;
  /** Per-step retry budget before a prospect is durably skipped. */
  maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// Durable per-prospect progress (stored in the job's metadata_json)
// ---------------------------------------------------------------------------

export interface ProspectProgress {
  /** Executions already performed this run and in prior runs, keyed by state. */
  attempts: Record<string, number>;
  /** Terminal outcome for prospects that can no longer be processed. */
  terminal?: "skipped" | "ready" | "complete" | null;
  /** Whether the prospect is waiting on a human/admin action for now. */
  parked?: boolean;
  /** Most recent Agent 9 state observed for this prospect. */
  lastState?: CampaignState | null;
  lastReason?: string | null;
  updatedAt?: string;
}

export interface CampaignRunState {
  prospectStates: Record<string, ProspectProgress>;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Summary returned to callers / the execute API
// ---------------------------------------------------------------------------

export interface ProspectRunSummary {
  leadId: string;
  businessName: string;
  state: CampaignState;
  reason: string;
  parked: boolean;
  terminal: boolean;
  skipped: boolean;
  attempts: Record<string, number>;
}

export interface CampaignExecutionSummary {
  campaignId: string;
  jobId: string;
  campaignStatus: string;
  processingStarted: boolean;
  discoveredProspects: number;
  prospects: ProspectRunSummary[];
  stopped: boolean;
  note: string;
}

/** Thrown when another campaign_orchestration job already owns this campaign. */
export class CampaignBusyError extends Error {
  constructor(campaignId: string) {
    super(`Campaign "${campaignId}" already has an active execution job.`);
    this.name = "CampaignBusyError";
  }
}