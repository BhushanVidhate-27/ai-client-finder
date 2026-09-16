import { NextResponse } from "next/server";
import { getLeadByPlaceId, upsertLeadFromDiscovery } from "@/lib/data/leads";
import { runJob, JobStopped } from "@/lib/jobs/run-job";
import { runWebsiteProjectGeneration } from "@/lib/jobs/website-project-flow";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";
import type { WebsiteResearch } from "@/lib/lead-research";
import type { QualifiedLead } from "@/lib/lead-qualification";
import type { ContactDiscovery } from "@/lib/contact-discovery";

interface WebsiteRequest {
  lead?: unknown;
  websiteResearch?: unknown;
}

function isContactDiscovery(v: unknown): v is ContactDiscovery {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.emailStatus === "string" || typeof c.contactMethod === "string"
  );
}

function isWebsiteResearch(v: unknown): v is WebsiteResearch {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.businessSummary === "string" &&
    typeof r.targetAudience === "string" &&
    typeof r.primaryCTA === "string" &&
    Array.isArray(r.services)
  );
}

export async function POST(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  let body: WebsiteRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const rawLead = body.lead;
  const rawResearch = body.websiteResearch;

  if (
    !rawLead ||
    typeof rawLead !== "object" ||
    typeof (rawLead as Record<string, unknown>).placeId !== "string" ||
    typeof (rawLead as Record<string, unknown>).businessName !== "string" ||
    typeof (rawLead as Record<string, unknown>).address !== "string" ||
    typeof (rawLead as Record<string, unknown>).googleMapsUrl !== "string" ||
    !isWebsiteResearch(rawResearch)
  ) {
    return NextResponse.json(
      {
        error:
          "lead (with placeId, businessName, address, googleMapsUrl) and websiteResearch are required with valid shape.",
      },
      { status: 400 },
    );
  }

  const lead = rawLead as Record<string, unknown>;

  const qualifiedLead: QualifiedLead = {
    placeId: String(lead.placeId),
    businessName: String(lead.businessName),
    address: String(lead.address),
    googleMapsUrl: String(lead.googleMapsUrl),
    websiteUrl: lead.websiteUrl ? String(lead.websiteUrl) : undefined,
    internationalPhoneNumber: lead.internationalPhoneNumber
      ? String(lead.internationalPhoneNumber)
      : undefined,
    nationalPhoneNumber: lead.nationalPhoneNumber
      ? String(lead.nationalPhoneNumber)
      : undefined,
    rating:
      typeof lead.rating === "number" ? lead.rating : undefined,
    reviewCount:
      typeof lead.reviewCount === "number" ? lead.reviewCount : undefined,
    businessStatus: lead.businessStatus
      ? String(lead.businessStatus)
      : undefined,
    primaryType: lead.primaryType ? String(lead.primaryType) : undefined,
    types: Array.isArray(lead.types)
      ? (lead.types as unknown[]).filter((t): t is string => typeof t === "string")
      : undefined,
    qualification: {
      opportunityScore: 0,
      qualified: true,
      reason: "",
      websiteAssessment: "",
      qualificationStatus: "complete",
    },
  };

  let contact: ContactDiscovery | null = null;
  if (isContactDiscovery(lead.contactDiscovery)) {
    contact = lead.contactDiscovery;
  }

  const existingStored = getLeadByPlaceId(qualifiedLead.placeId);
  const storedLead = (
    existingStored
      ? { lead: existingStored, created: false }
      : upsertLeadFromDiscovery(qualifiedLead, { updateExisting: false })
  ).lead;

  let jobId: string | null = null;
  let version: number | null = null;

  try {
    const outcome = await runJob(
      {
        type: "website_generation",
        leadId: storedLead.id,
        metadata: { placeId: storedLead.placeId, businessName: storedLead.businessName },
      },
      async (controller) => {
        jobId = controller.jobId;
        const flow = await runWebsiteProjectGeneration({
          leadId: storedLead.id,
          lead: qualifiedLead,
          contact,
          research: rawResearch,
          controller,
        });
        version = flow.version;
        return {
          status: "completed" as const,
          project: {
            projectId: flow.projectId,
            websiteProjectId: flow.websiteProjectId,
            businessName: flow.businessName,
            slug: flow.workspaceId,
            status: flow.status,
            version: flow.version,
            buildStatus: flow.buildStatus,
            qaStatus: flow.qaStatus,
            artifactHash: flow.artifactHash,
            currentVersion: flow.currentVersion,
          },
          errorMessage: null,
        };
      },
    );

    return NextResponse.json(
      {
        status: outcome.result.status,
        project: outcome.result.project,
        errorMessage: outcome.result.errorMessage,
        version,
        jobId: outcome.jobId,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof JobStopped) {
      return NextResponse.json(
        {
          status: "stopped",
          project: null,
          errorMessage: "Website generation was stopped.",
          version,
          jobId,
        },
        { status: 200 },
      );
    }
    const message = "Website generation is temporarily unavailable.";
    return NextResponse.json(
      {
        status: "failed",
        project: null,
        errorMessage: message,
        version: null,
        jobId,
      },
      { status: 200 },
    );
  }
}