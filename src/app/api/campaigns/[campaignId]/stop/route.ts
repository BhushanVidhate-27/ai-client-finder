import { NextResponse } from "next/server";
import { getCampaign, updateCampaignStatus } from "@/lib/data/campaigns";
import { listJobsByCampaign, isActiveJobStatus } from "@/lib/data/jobs";
import { getJobController } from "@/lib/jobs/registry";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

/**
 * POST /api/campaigns/[campaignId]/stop
 *
 * Durable, campaign-wide stop. The campaign status is the source of truth;
 * any active execution controller is also signalled so an in-flight runner
 * halts at its next checkpoint. Stopped campaigns refuse to execute until
 * resumed.
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

  const updated = updateCampaignStatus(campaignId, "stopped");

  // Best-effort cooperative stop for any in-flight execution job.
  for (const job of listJobsByCampaign(campaignId, 50)) {
    if (job.type === "campaign_orchestration" && isActiveJobStatus(job.status)) {
      getJobController(job.id)?.requestStop();
    }
  }

  return NextResponse.json(
    { campaignId, status: updated?.status ?? "stopped" },
    { status: 200 },
  );
}