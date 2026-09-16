import { NextResponse } from "next/server";
import { listCampaigns, campaignLeadCounts } from "@/lib/data/campaigns";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export async function GET(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const campaigns = listCampaigns(200);
  const counts = campaignLeadCounts(campaigns.map((c) => c.id));
  return NextResponse.json({
    campaigns: campaigns.map((campaign) => ({
      ...campaign,
      leadCount: counts.get(campaign.id) ?? 0,
    })),
  });
}