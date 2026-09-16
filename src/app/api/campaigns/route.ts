import { NextResponse } from "next/server";
import { searchPlaces } from "@/lib/google-places";
import { qualifyLeads } from "@/lib/lead-qualification";
import { discoveryPoolSize, selectProspects } from "@/lib/website-opportunity";
import {
  createCampaign,
  linkCampaignLead,
} from "@/lib/data/campaigns";
import {
  toLeadView,
  upsertLeadFromDiscovery,
  buildDuplicateInfo,
  setLeadPrimaryCampaign,
  type LeadView,
} from "@/lib/data/leads";
import { updateJob } from "@/lib/data/jobs";
import { logActivity } from "@/lib/data/activity";
import { runJob, JobStopped } from "@/lib/jobs/run-job";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

type CreateCampaignRequest = {
  niche?: unknown;
  location?: unknown;
  leadCount?: unknown;
};

interface CampaignResponse {
  campaign: {
    id: string;
    niche: string;
    location: string;
    leadCount: number;
    status: string;
  };
  leads: LeadView[];
  duplicates: Array<{
    placeId: string;
    businessName: string;
    websiteVersions: number;
    lastGeneratedAt: string | null;
    lastResearchedAt: string | null;
  }>;
  jobId: string | null;
}

export async function POST(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  let body: CreateCampaignRequest;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const niche = typeof body.niche === "string" ? body.niche.trim() : "";
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const leadCount = body.leadCount;

  if (!niche) {
    return NextResponse.json({ error: "Niche is required." }, { status: 400 });
  }

  if (!location) {
    return NextResponse.json(
      { error: "Location is required." },
      { status: 400 },
    );
  }

  if (typeof leadCount !== "number" || !Number.isInteger(leadCount) || leadCount < 1) {
    return NextResponse.json(
      { error: "Lead count must be a positive whole number." },
      { status: 400 },
    );
  }

  let response: CampaignResponse;

  try {
    const outcome = await runJob(
      {
        type: "campaign_discovery",
        metadata: { niche, location, leadCount },
      },
      async (controller) => {
        // Discover a larger candidate pool so genuine opportunities (no
        // website / needs redesign) can surface from more than the first N
        // raw Google Places results.
        const discoveredLeads = await searchPlaces(niche, location, leadCount, {
          discoveryPool: discoveryPoolSize(leadCount),
        });
        await controller.checkpoint();
        updateJob(controller.jobId, {
          progress: 20,
          currentStep: `discovered ${discoveredLeads.length} candidates`,
        });

        // Deterministically classifies each website and applies the final
        // qualification rules (GOOD_WEBSITE / UNKNOWN are never qualified).
        const qualifiedLeads = await qualifyLeads(niche, location, discoveredLeads);
        updateJob(controller.jobId, {
          progress: 60,
          currentStep: "persisting campaign",
        });

        const campaign = createCampaign({
          niche,
          location,
          requestedLeadCount: leadCount,
          status: "Discovery and qualification complete",
        });
        logActivity({
          action: "campaign.created",
          campaignId: campaign.id,
          jobId: controller.jobId,
          metadata: { niche, location, leadCount, discovered: discoveredLeads.length },
        });

        // Genuine opportunities only: NO_WEBSITE first, NEEDS_REDESIGN next,
        // other website-bearing businesses excluded. Never padded to leadCount.
        const prospects = selectProspects(qualifiedLeads, leadCount);
        const prospectPlaceIds = new Set(prospects.map((lead) => lead.placeId));
        const displayOrder = [
          ...prospects,
          ...qualifiedLeads.filter((lead) => !prospectPlaceIds.has(lead.placeId)),
        ];

        const leads: LeadView[] = [];
        const duplicates: CampaignResponse["duplicates"] = [];

        for (const qualifiedLead of displayOrder) {
          // Refresh stored qualification on rediscovery so a business that now
          // has a good website can never stay qualified from an old campaign.
          const { lead: stored, created } = upsertLeadFromDiscovery(
            qualifiedLead,
            { updateExisting: true },
          );
          if (created) {
            setLeadPrimaryCampaign(stored.id, campaign.id);
            logActivity({
              action: "lead.discovered",
              campaignId: campaign.id,
              leadId: stored.id,
              metadata: { placeId: stored.placeId },
            });
          }
          // A place may already be a lead discovered by an earlier campaign;
          // it still belongs to this campaign's history, so link it too. The
          // link is idempotent (INSERT OR IGNORE).
          linkCampaignLead(campaign.id, stored.id);

          const view = toLeadView(stored);
          if (!created) {
            view.existing = true;
            view.duplicateInfo = buildDuplicateInfo(stored);
            duplicates.push({
              placeId: stored.placeId,
              businessName: stored.businessName,
              websiteVersions: view.duplicateInfo.websiteVersions,
              lastGeneratedAt: view.duplicateInfo.lastGeneratedAt,
              lastResearchedAt: view.duplicateInfo.lastResearchedAt,
            });
          }
          leads.push(view);
        }

        updateJob(controller.jobId, {
          progress: 100,
          currentStep: `discovered ${prospects.length} genuine opportunities`,
        });

        return { campaign, leads, duplicates, prospects };
      },
    );

    response = {
      campaign: {
        id: outcome.result.campaign.id,
        niche,
        location,
        leadCount,
        status: outcome.result.campaign.status,
      },
      leads: outcome.result.leads,
      duplicates: outcome.result.duplicates,
      jobId: outcome.jobId,
    };
    logActivity({
      action: "campaign.finished",
      campaignId: outcome.result.campaign.id,
      jobId: outcome.jobId,
      metadata: {
        leadCount: outcome.result.leads.length,
        prospectCount: outcome.result.prospects.length,
        duplicateCount: outcome.result.duplicates.length,
      },
    });
  } catch (error) {
    if (error instanceof JobStopped) {
      return NextResponse.json(
        { error: "Campaign discovery was stopped." },
        { status: 502 },
      );
    }
    const message =
      error instanceof Error ? error.message : "Failed to search places.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  return NextResponse.json(response, { status: 201 });
}