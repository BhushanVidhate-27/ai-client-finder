/**
 * Campaign Execution (Step 16) — durable checkpointing.
 *
 * Per-prospect progress is persisted in the campaign execution job's
 * metadata_json so a stopped/interrupted/failed run can resume without
 * redoing work. Agent 9 derives the next state from the database, so an
 * execution that already completed a step naturally re-evaluates to the next
 * state; the attempt counters below are the only extra bookkeeping the runner
 * needs across runs.
 */

import {
  getJob,
  listJobsByCampaign,
  updateJobMetadata,
} from "@/lib/data/jobs";
import type { CampaignRunState } from "./types";

export const CAMPAIGN_RUN_META_KEY = "campaignRun";

export function readCampaignRunState(jobId: string): CampaignRunState | null {
  const job = getJob(jobId);
  if (!job) return null;
  const value = job.metadata[CAMPAIGN_RUN_META_KEY];
  return isRunState(value) ? value : null;
}

export function writeCampaignRunState(
  jobId: string,
  state: CampaignRunState,
): void {
  updateJobMetadata(jobId, { [CAMPAIGN_RUN_META_KEY]: state });
}

/**
 * Loads the most recently written campaign-run state for a campaign from ANY
 * of its execution jobs (usually a prior completed/stopped run), so attempt
 * counters survive across invocations. The current job (if it has already
 * written state) always wins.
 */
export function loadPriorRunState(
  campaignId: string,
  excludeJobId?: string,
): CampaignRunState | null {
  const jobs = listJobsByCampaign(campaignId, 50);
  for (const job of jobs) {
    if (job.id === excludeJobId) continue;
    const value = job.metadata[CAMPAIGN_RUN_META_KEY];
    if (isRunState(value)) return value;
  }
  return null;
}

export function emptyRunState(now: string): CampaignRunState {
  return { prospectStates: {}, startedAt: now };
}

function isRunState(value: unknown): value is CampaignRunState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.startedAt === "string" &&
    candidate.prospectStates !== null &&
    typeof candidate.prospectStates === "object"
  );
}