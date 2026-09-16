import { NextResponse } from "next/server";
import { getCampaign, updateCampaignStatus } from "@/lib/data/campaigns";
import { listJobsByCampaign, isActiveJobStatus } from "@/lib/data/jobs";
import { getJobController } from "@/lib/jobs/registry";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

/**
 * POST /api/campaigns/[campaignId]/pause
 *
 * Durable, campaign-wide pause. The campaign status is the source of truth;
 * any active execution controller is signalled at its next checkpoint so the
 * running job returns a parked summary and can be resumed later.
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

  const updated = updateCampaignStatus(campaignId, "paused");

  for (const job of listJobsByCampaign(campaignId, 50)) {
    if (job.type === "campaign_orchestration" && isActiveJobStatus(job.status)) {
      getJobController(job.id)?.requestPause();
    }
  }

  return NextResponse.json(
    { campaignId, status: updated?.status ?? "paused" },
    { status: 200 },
  );
}