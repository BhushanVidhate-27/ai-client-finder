import { NextResponse } from "next/server";
import { researchLeads, type ResearchResult } from "@/lib/lead-research";
import type { QualifiedLead } from "@/lib/lead-qualification";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import { getLeadByPlaceId } from "@/lib/data/leads";
import { upsertResearch } from "@/lib/data/research";
import { updateJob } from "@/lib/data/jobs";
import { runJob, JobStopped } from "@/lib/jobs/run-job";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

type ResearchRequest = {
  leads?: unknown;
};

interface LeadWithContact {
  qualification?: { qualified?: unknown };
  contactDiscovery?: unknown;
}

function isLead(value: unknown): value is QualifiedLead & LeadWithContact {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.placeId === "string" &&
    typeof candidate.businessName === "string"
  );
}

function isContactDiscovery(value: unknown): value is ContactDiscovery {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.emailStatus === "string" || typeof candidate.contactMethod === "string";
}

export async function POST(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  let body: ResearchRequest;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.leads)) {
    return NextResponse.json(
      { error: "leads must be an array." },
      { status: 400 },
    );
  }

  const leads = body.leads.filter(isLead) as Array<QualifiedLead & LeadWithContact>;

  const contactByPlaceId = new Map<string, ContactDiscovery | null | undefined>();
  for (const lead of leads) {
    if (isContactDiscovery(lead.contactDiscovery)) {
      contactByPlaceId.set(lead.placeId, lead.contactDiscovery);
    }
  }

  const qualifiedLeads = leads.filter(
    (lead) => lead.qualification?.qualified === true,
  );

  const leadIdByPlaceId = new Map<string, string>();
  for (const lead of qualifiedLeads) {
    const stored = getLeadByPlaceId(lead.placeId);
    if (stored) leadIdByPlaceId.set(stored.placeId, stored.id);
  }

  const gathered: ResearchResult[] = [];
  let completedCount = 0;
  let stopped = false;
  let jobId: string | null = null;

  try {
    const outcome = await runJob(
      {
        type: "research",
        metadata: {
          count: qualifiedLeads.length,
          placeIds: qualifiedLeads.map((lead) => lead.placeId),
        },
      },
      async (controller) => {
        updateJob(controller.jobId, { currentStep: "researching leads" });
        return researchLeads(qualifiedLeads, contactByPlaceId, 3, {
          beforeLead: async () => {
            await controller.checkpoint();
          },
          afterLead: async (lead, result) => {
            gathered.push(result);
            completedCount += 1;
            updateJob(controller.jobId, {
              progress: Math.round(
                (completedCount / qualifiedLeads.length) * 100,
              ),
              currentStep: `researched ${completedCount}/${qualifiedLeads.length}`,
            });
            if (result.status === "complete" && result.websiteResearch) {
              const leadId = leadIdByPlaceId.get(lead.placeId);
              if (leadId) upsertResearch(leadId, result.websiteResearch);
            }
          },
        });
      },
    );
    jobId = outcome.jobId;
  } catch (error) {
    if (error instanceof JobStopped) {
      jobId = error.jobId;
      stopped = true;
    } else {
      const message = error instanceof Error ? error.message : "Research failed.";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  return NextResponse.json({ results: gathered, jobId, stopped }, { status: 200 });
}