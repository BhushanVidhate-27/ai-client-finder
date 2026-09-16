import { NextResponse } from "next/server";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";
import { getCampaignExecutionSummary } from "@/lib/campaign-execution/runner";

/**
 * GET /api/campaigns/[campaignId]/execution
 *
 * Read-only Agent 9 report: per-prospect state/reason/nextAction, parking and
 * terminal flags, and the durable attempt counters from the latest run. Never
 * performs work.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const { campaignId } = await params;
  const summary = getCampaignExecutionSummary(campaignId);
  if (!summary) {
    return NextResponse.json({ error: "Campaign not found." }, { status: 404 });
  }
  return NextResponse.json(summary, { status: 200 });
}