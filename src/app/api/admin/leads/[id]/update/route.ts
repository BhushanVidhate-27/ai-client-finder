import { NextResponse } from "next/server";
import {
  buildDuplicateInfo,
  getLeadById,
  toLeadView,
  toQualifiedLead,
} from "@/lib/data/leads";
import { upsertResearch } from "@/lib/data/research";
import {
  countWebsiteVersions,
  getLatestWebsiteVersion,
} from "@/lib/data/websites";
import { updateJob } from "@/lib/data/jobs";
import { logActivity } from "@/lib/data/activity";
import { runJob } from "@/lib/jobs/run-job";
import { researchLead } from "@/lib/lead-research";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export async function POST(
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

  try {
    const outcome = await runJob(
      { type: "lead_update", leadId: id, metadata: { placeId: stored.placeId } },
      async (controller) => {
        updateJob(controller.jobId, { currentStep: "researching lead" });
        const result = await researchLead(
          toQualifiedLead(stored),
          stored.contactDiscovery,
        );
        if (result.status === "complete" && result.websiteResearch) {
          upsertResearch(id, result.websiteResearch);
          return result.websiteResearch;
        }
        throw new Error(result.errorMessage ?? "Research failed.");
      },
    );

    logActivity({
      action: "lead.research_updated",
      leadId: id,
      metadata: { reason: "manual_update" },
    });

    const freshLead = getLeadById(id);
    if (!freshLead) {
      return NextResponse.json({ error: "Lead not found." }, { status: 404 });
    }
    const view = toLeadView(freshLead);
    view.existing = true;
    view.duplicateInfo = buildDuplicateInfo(freshLead);
    const latestVersion = getLatestWebsiteVersion(id);

    return NextResponse.json({
      lead: view,
      research: outcome.result,
      websiteVersions: countWebsiteVersions(id),
      latestWebsiteVersion: latestVersion ? latestVersion.version : null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Update failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}