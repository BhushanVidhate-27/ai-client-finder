/**
 * Campaign Execution (Step 16) — the durable campaign runner.
 *
 * The runner coordinates the existing A1–A8 flows. It never decides anything
 * itself: every transition is given by Agent 9 (evaluateNextAction), every
 * mutating step is executed by the matching production flow, and progress is
 * persisted to the job's metadata between every unit of work so a stopped or
 * interrupted run resumes cheaply.
 *
 * Semantics:
 *  - Round-robin: each sweep advances every linked prospect by exactly one
 *    step, so no single prospect can starve the others and pause/stop checks
 *    run between every prospect.
 *  - Parking: WAIT / WAIT_FOR_* states end a prospect's sweeps for this run.
 *  - Terminal: SKIP_PROSPECT / COMPLETE / READY_FOR_TRANSPORT are permanent
 *    and never retried.
 *  - STOP: campaign.status 'stopped' ends the run gracefully; a cooperative
 *    stop request (JobController) surfaces as JobStoppedError immediately.
 *  - PAUSE: campaign.status 'paused' parks all prospects; the job returns
 *    completed so a later resume re-enters and continues where it left off.
 *  - Retry: executor failures re-run through Agent 9; if the failing state is
 *    stable and the attempt budget is exhausted the prospect is durably
 *    skipped, never retried forever.
 */

import { JobController, JobStoppedError } from "@/lib/jobs/controller";
import {
  countCampaignLeads,
  getCampaign,
  listLeadsByCampaign,
  type CampaignRow,
} from "@/lib/data/campaigns";
import {
  listJobsByCampaign,
  updateJob,
  isActiveJobStatus,
} from "@/lib/data/jobs";
import { logActivity } from "@/lib/data/activity";
import { evaluateNextAction } from "@/lib/campaign-orchestrator/evaluate";
import { mapCampaignRunState } from "@/lib/outreach-safety/safety";
import {
  classifyAction,
  executeProspectStep,
  runDiscoveryForCampaign,
  evaluateProspectForSummary,
  buildSummaryLine,
} from "./executors";
import {
  CAMPAIGN_RUN_META_KEY,
  emptyRunState,
  loadPriorRunState,
  readCampaignRunState,
  writeCampaignRunState,
} from "./checkpoint";
import {
  CampaignBusyError,
  type CampaignExecutionServices,
  type CampaignExecutionSummary,
  type CampaignRunState,
  type ProspectProgress,
} from "./types";

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_SWEEPS = 60;

export interface RunCampaignExecutionOptions {
  controller: JobController;
  services?: CampaignExecutionServices;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Runs (or resumes) a campaign through the Agent 9 pipeline. Returns a
 * read-only summary of per-prospect progress and the campaign outcome.
 */
export async function runCampaignExecution(
  campaignId: string,
  options: RunCampaignExecutionOptions,
): Promise<CampaignExecutionSummary> {
  const { controller } = options;
  const services = options.services ?? {};

  let campaign = getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign "${campaignId}" not found.`);

  // Secondary exclusivity guard. The execute API already rejects duplicates,
  // but a race (or a parallel worker) could still start a second job, so the
  // runner re-checks inside the job before doing any work.
  const activeJob = listJobsByCampaign(campaignId, 50).find(
    (job) =>
      job.type === "campaign_orchestration" &&
      isActiveJobStatus(job.status) &&
      job.id !== controller.jobId,
  );
  if (activeJob) throw new CampaignBusyError(campaignId);

  // Respect a terminal campaign state without touching the world.
  if (mapCampaignRunState(campaign.status) === "stopped") {
    updateJob(controller.jobId, {
      progress: 100,
      currentStep: "campaign already stopped",
    });
    return buildSummary(campaignId, controller.jobId, campaign, null, true);
  }

  updateJob(controller.jobId, { currentStep: "campaign execution started" });

  // Resume: load the durable progress (own job first, then any prior run).
  const state: CampaignRunState =
    readCampaignRunState(controller.jobId) ??
    loadPriorRunState(campaignId, controller.jobId) ??
    emptyRunState(nowIso());

  // Phase 1 — discovery: link genuine prospects into an empty campaign.
  if (countCampaignLeads(campaignId) === 0) {
    await controller.checkpoint();
    const linked = await runDiscoveryForCampaign(campaign, controller, services);
    updateJob(controller.jobId, {
      progress: 10,
      currentStep: `${linked} prospects discovered`,
    });
  }

  // Phase 2 — round-robin: sweep over all linked prospects, advancing each by
  // exactly one step, until a sweep makes no progress at all.
  let sweep = 0;
  let madeProgress = true;
  while (madeProgress && sweep < MAX_SWEEPS) {
    sweep += 1;
    madeProgress = false;

const leads = listLeadsByCampaign(campaignId);
    for (const row of leads) {
      campaign = getCampaign(campaignId) ?? campaign;
      const leadId = String((row as { id?: unknown }).id);

      // Durable campaign-level control (mirrors evaluate's run-state mapping,
      // so "halted"/"cancelled" are treated as stopped too).
      const runState = mapCampaignRunState(campaign.status);
      if (runState === "stopped") {
        updateJob(controller.jobId, {
          currentStep: "campaign stopped by administrator",
        });
        writeCampaignRunState(controller.jobId, state);
        return buildSummary(campaignId, controller.jobId, campaign, state, true);
      }
      if (runState === "paused") {
        updateJob(controller.jobId, {
          currentStep: "campaign paused; work parked",
        });
        writeCampaignRunState(controller.jobId, state);
        return buildSummary(campaignId, controller.jobId, campaign, state, false);
      }

      const outcome = await advanceProspectOneStep(
        campaign,
        leadId,
        controller,
        services,
        state,
      );
      if (outcome === "advanced" || outcome === "retrying") madeProgress = true;
      if (outcome === "stopped") {
        writeCampaignRunState(controller.jobId, state);
        return buildSummary(campaignId, controller.jobId, campaign, state, true);
      }

      // A cooperative stop request from a human/admin halts immediately.
      if (controller.isStopRequested) throw new JobStoppedError();
    }

    writeCampaignRunState(controller.jobId, state);
    updateJob(controller.jobId, {
      progress: Math.min(90, 10 + sweep * 2),
      currentStep: `sweep ${sweep} complete`,
    });
  }

  writeCampaignRunState(controller.jobId, state);
  updateJob(controller.jobId, {
    progress: 100,
    currentStep: "campaign sweep complete",
  });

  return buildSummary(campaignId, controller.jobId, campaign, state, false);
}

/**
 * Read-only snapshot of a campaign's execution state — the GET endpoint for
 * the execution report. Never performs work; Agent 9 is the source of truth.
 * Returns null when the campaign does not exist.
 */
export function getCampaignExecutionSummary(
  campaignId: string,
): CampaignExecutionSummary | null {
  const campaign = getCampaign(campaignId);
  if (!campaign) return null;
  const stopRequested = campaign.status === "stopped";
  const richest = latestRunState(campaignId);
  return buildSummary(
    campaignId,
    "execution-report",
    campaign,
    richest,
    stopRequested,
  );
}

function latestRunState(campaignId: string): CampaignRunState | null {
  const jobs = listJobsByCampaign(campaignId, 50);
  for (const job of jobs) {
    const value = job.metadata[CAMPAIGN_RUN_META_KEY];
    if (value && typeof value === "object") {
      return value as CampaignRunState;
    }
  }
  return null;
}

type ProspectOutcome =
  | "advanced"
  | "retrying"
  | "parked"
  | "terminal"
  | "exhausted"
  | "stopped";

/**
 * Advances a single prospect by exactly one step (evaluate -> maybe execute ->
 * persist). Returns what happened so the caller can decide whether the sweep
 * should continue.
 */
async function advanceProspectOneStep(
  campaign: CampaignRow,
  leadId: string,
  controller: JobController,
  services: CampaignExecutionServices,
  state: CampaignRunState,
): Promise<ProspectOutcome> {
  const maxAttempts = services.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const progress: ProspectProgress =
    state.prospectStates[leadId] ??
    { attempts: {}, lastState: null, lastReason: null, updatedAt: nowIso() };
  state.prospectStates[leadId] = progress;

  // Terminal prospects are permanently done — never touch them again.
  if (progress.terminal) return "terminal";

  await controller.checkpoint();

  const freshRunState = mapCampaignRunState(
    getCampaign(campaign.id)?.status ?? campaign.status,
  );
  if (freshRunState === "stopped") return "stopped";
  if (freshRunState === "paused") {
    progress.parked = true;
    progress.updatedAt = nowIso();
    writeCampaignRunState(controller.jobId, state);
    return "parked";
  }

  const decision = evaluateNextAction({ leadId });
  const stateName = decision.state;
  progress.lastState = stateName;
  progress.lastReason = decision.reason;
  progress.parked = false;
  progress.updatedAt = nowIso();

  // STOP (cooperative controller stop or halted/cancelled campaign) aborts the
  // whole run; it never parks a single prospect.
  if (stateName === "STOP") {
    updateJob(controller.jobId, {
      currentStep: `stopped at prospect ${leadId}`,
    });
    return "stopped";
  }

  const actionKind = classifyAction(stateName);

  if (actionKind === "terminal") {
    progress.terminal =
      stateName === "SKIP_PROSPECT"
        ? "skipped"
        : stateName === "READY_FOR_TRANSPORT"
          ? "ready"
          : "complete";
    progress.parked = false;
    progress.updatedAt = nowIso();
    writeCampaignRunState(controller.jobId, state);
    updateJob(controller.jobId, {
      currentStep: `prospect ${leadId} reached ${stateName}`,
    });
    logActivity({
      action: "campaign.prospect_terminal",
      campaignId: campaign.id,
      leadId,
      jobId: controller.jobId,
      metadata: { state: stateName },
    });
    return "terminal";
  }

  if (actionKind === "parking") {
    progress.parked = true;
    progress.updatedAt = nowIso();
    writeCampaignRunState(controller.jobId, state);
    return "parked";
  }

  // Executable state — run the matching production flow exactly once.
  const attempt = (progress.attempts[stateName] ?? 0) + 1;
  progress.attempts[stateName] = attempt;
  progress.updatedAt = nowIso();
  writeCampaignRunState(controller.jobId, state);

  try {
    await executeProspectStep(stateName, leadId, campaign, controller, services);
    // Success — the next sweep's evaluation moves the prospect along.
    return "advanced";
  } catch (error) {
    if (error instanceof JobStoppedError) throw error;
    if (attempt >= maxAttempts) {
      progress.terminal = "skipped";
      progress.parked = false;
      progress.updatedAt = nowIso();
      writeCampaignRunState(controller.jobId, state);
      updateJob(controller.jobId, {
        currentStep: `prospect ${leadId} skipped after ${attempt} failed attempts`,
      });
      logActivity({
        action: "campaign.prospect_skipped",
        campaignId: campaign.id,
        leadId,
        jobId: controller.jobId,
        metadata: {
          state: stateName,
          attempts: attempt,
          reason: error instanceof Error ? error.message : "execution failed",
        },
      });
      return "exhausted";
    }
    // Retry on the next sweep; the attempt counter increments again if the
    // same state is still requested.
    return "retrying";
  }
}

function buildSummary(
  campaignId: string,
  jobId: string,
  campaign: CampaignRow,
  state: CampaignRunState | null,
  stopped: boolean,
): CampaignExecutionSummary {
  const leads = listLeadsByCampaign(campaignId);
  const prospects = leads.map((row) => {
    const leadId = String((row as { id?: unknown }).id);
    const evalResult = evaluateProspectForSummary(leadId);
    return buildSummaryLine(
      evalResult,
      state?.prospectStates[leadId] ?? { attempts: {} },
    );
  });
  const attemptsRecorded = prospects.reduce(
    (sum, prospect) => sum + Object.keys(prospect.attempts).length,
    0,
  );
  return {
    campaignId,
    jobId,
    campaignStatus: campaign.status,
    processingStarted: prospects.length > 0 || attemptsRecorded > 0,
    discoveredProspects: prospects.length,
    prospects,
    stopped,
    note: stopped
      ? "Campaign is stopped; no further work will run until it is resumed."
      : "Sweep complete; prospects waiting on approvals are parked.",
  };
}