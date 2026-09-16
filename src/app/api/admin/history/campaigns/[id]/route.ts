import { NextResponse } from "next/server";
import {
  getCampaign,
  listLeadsByCampaign,
} from "@/lib/data/campaigns";
import {
  buildDuplicateInfo,
  getLeadById,
  toLeadView,
  type LeadView,
} from "@/lib/data/leads";
import { listActivity } from "@/lib/data/activity";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const { id } = await params;
  const campaign = getCampaign(id);
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found." }, { status: 404 });
  }

  const leads: LeadView[] = [];
  for (const row of listLeadsByCampaign(id)) {
    const stored = getLeadById(String(row.id));
    if (!stored) continue;
    const view = toLeadView(stored);
    const existedBefore =
      stored.campaignId !== null && stored.campaignId !== id;
    if (existedBefore) {
      view.existing = true;
      view.duplicateInfo = buildDuplicateInfo(stored);
    }
    leads.push(view);
  }

  const activity = listActivity({ campaignId: id, limit: 100 });

  return NextResponse.json({ campaign, leads, activity });
}