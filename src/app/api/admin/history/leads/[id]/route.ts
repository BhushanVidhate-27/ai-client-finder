import { NextResponse } from "next/server";
import {
  buildDuplicateInfo,
  getLeadById,
  toLeadView,
} from "@/lib/data/leads";
import { listCampaignIdsByLeadId } from "@/lib/data/campaigns";
import { getResearchByLeadId } from "@/lib/data/research";
import { listWebsiteVersions } from "@/lib/data/websites";
import { listJobsByLead } from "@/lib/data/jobs";
import { listDeploymentRecordsByLead } from "@/lib/data/deployments";
import { listActivity } from "@/lib/data/activity";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";
import {
  listOutreachDraftsByLead,
  listOutreachApprovalsByLead,
  listOutreachSendsByLead,
  getOutreachOptOut,
} from "@/lib/data/outreach";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const { id } = await params;
  const stored = getLeadById(id);
  if (!stored) {
    return NextResponse.json({ error: "Lead not found." }, { status: 404 });
  }

  const campaignIds = listCampaignIdsByLeadId(id);
  const research = getResearchByLeadId(id);
  const versions = listWebsiteVersions(id);
  const jobs = listJobsByLead(id);
  const deployments = listDeploymentRecordsByLead(id);

  const activity = listActivity({
    leadId: id,
    campaignIds: campaignIds.length > 0 ? campaignIds : undefined,
    limit: 200,
  });

  const outreachDrafts = listOutreachDraftsByLead(id);
  const outreachApprovals = listOutreachApprovalsByLead(id);
  const outreachOptOut = getOutreachOptOut(id);
  const outreachSends = listOutreachSendsByLead(id);

  const view = toLeadView(stored);
  view.existing = campaignIds.length > 0;
  view.duplicateInfo = buildDuplicateInfo(stored);

  return NextResponse.json({
    lead: view,
    research: research ? research.websiteResearch : null,
    researchUpdatedAt: research ? research.updatedAt : null,
    websiteVersions: versions,
    jobs,
    activity,
    campaignIds,
    deployments,
    outreachDrafts,
    outreachApprovals,
    outreachOptOut,
    outreachSends,
  });
}