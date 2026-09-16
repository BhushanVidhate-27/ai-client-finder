import { NextResponse } from "next/server";
import { getCampaign } from "@/lib/data/campaigns";
import { listJobsByCampaign, isActiveJobStatus } from "@/lib/data/jobs";
import { runJob, JobStopped } from "@/lib/jobs/run-job";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";
import {
  runCampaignExecution,
} from "@/lib/campaign-execution/runner";
import { CampaignBusyError } from "@/lib/campaign-execution/types";

/**
 * POST /api/campaigns/[campaignId]/execute
 *
 * Runs (or resumes) the Agent 9 execution pipeline for the campaign in a
 * durable job. Duplicate invocations while another campaign_orchestration job
 * is active return 409. This endpoint is coordination only — every stage is
 * performed by the existing A1–A8 flows and every approval gate still applies.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const { campaignId } = await params;
  const campaign = getCampaign(campaignId);
  if (!campaign) {
    return NextResponse.json(
      { error: "Campaign not found." },
      { status: 404 },
    );
  }

  const activeJob = listJobsByCampaign(campaignId, 50).some(
    (job) =>
      job.type === "campaign_orchestration" && isActiveJobStatus(job.status),
  );
  if (activeJob) {
    return NextResponse.json(
      { error: `Campaign "${campaignId}" already has an active execution job.` },
      { status: 409 },
    );
  }

  try {
    const outcome = await runJob(
      {
        type: "campaign_orchestration",
        campaignId,
        metadata: { source: "execute-api" },
      },
      (controller) => runCampaignExecution(campaignId, { controller }),
    );
    return NextResponse.json(outcome.result, { status: 200 });
  } catch (error) {
    if (error instanceof JobStopped) {
      return NextResponse.json(
        {
          campaignId,
          stopped: true,
          note: "Execution was stopped cooperatively; progress was preserved.",
        },
        { status: 200 },
      );
    }
    if (error instanceof CampaignBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message =
      error instanceof Error ? error.message : "Campaign execution failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}