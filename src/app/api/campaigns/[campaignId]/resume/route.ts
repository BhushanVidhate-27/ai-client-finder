import { NextResponse } from "next/server";
import { getCampaign, updateCampaignStatus } from "@/lib/data/campaigns";
import { listJobsByCampaign } from "@/lib/data/jobs";
import { getJobController } from "@/lib/jobs/registry";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

/**
 * POST /api/campaigns/[campaignId]/resume
 *
 * Returns a stopped or paused campaign to the active state so the execution
 * pipeline can be re-triggered. Progress from prior runs is preserved in the
 * job metadata and merges on the next execute.
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
    return NextResponse.json({ error: "Campaign not found." }, { status: 404 });
  }

  const updated = updateCampaignStatus(campaignId, "active");

  for (const job of listJobsByCampaign(campaignId, 50)) {
    if (job.type !== "campaign_orchestration") continue;
    const controller = getJobController(job.id);
    if (!controller) continue;
    controller.resume();
  }

  // The latest stopped execution job is left as 'stopped' so history stays
  // accurate; a fresh execute invocation creates a new job and resumes from
  // the durable run state.
  return NextResponse.json(
    { campaignId, status: updated?.status ?? "active" },
    { status: 200 },
  );
}