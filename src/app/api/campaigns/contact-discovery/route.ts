import { NextResponse } from "next/server";
import { discoverContacts, type ContactDiscovery } from "@/lib/contact-discovery";
import type { QualifiedLead } from "@/lib/lead-qualification";
import { getLeadByPlaceId, updateLeadContactDiscovery } from "@/lib/data/leads";
import { updateJob } from "@/lib/data/jobs";
import { runJob, JobStopped } from "@/lib/jobs/run-job";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

type ContactDiscoveryRequest = {
  leads?: unknown;
};

type LeadWithContact = QualifiedLead & { contactDiscovery: ContactDiscovery | null };

function isLead(value: unknown): value is QualifiedLead {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.placeId === "string" && typeof candidate.businessName === "string";
}

export async function POST(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  let body: ContactDiscoveryRequest;

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

  const leads = body.leads.filter(isLead);

  if (leads.length === 0) {
    return NextResponse.json({ leads: [] }, { status: 200 });
  }

  const qualifiedLeads = leads.filter((lead) => lead.qualification?.qualified === true);

  const contactByPlaceId = new Map<string, ContactDiscovery>();
  const leadIdByPlaceId = new Map<string, string>();
  for (const lead of qualifiedLeads) {
    const stored = getLeadByPlaceId(lead.placeId);
    if (stored) leadIdByPlaceId.set(stored.placeId, stored.id);
  }

  let completedCount = 0;
  let stopped = false;
  let jobId: string | null = null;

  try {
    await runJob(
      {
        type: "contact_discovery",
        metadata: {
          count: qualifiedLeads.length,
          placeIds: qualifiedLeads.map((lead) => lead.placeId),
        },
      },
      async (controller) => {
        updateJob(controller.jobId, { currentStep: "discovering contacts" });
        const discoveries = await discoverContacts(qualifiedLeads, 3, {
          beforeLead: async () => {
            await controller.checkpoint();
          },
          afterLead: async (lead, discovery) => {
            contactByPlaceId.set(lead.placeId, discovery);
            const leadId = leadIdByPlaceId.get(lead.placeId);
            if (leadId) updateLeadContactDiscovery(leadId, discovery);
            completedCount += 1;
            updateJob(controller.jobId, {
              progress: Math.round(
                (completedCount / qualifiedLeads.length) * 100,
              ),
              currentStep: `contacted ${completedCount}/${qualifiedLeads.length}`,
            });
          },
        });
        return discoveries;
      },
    ).then((outcome) => {
      jobId = outcome.jobId;
    });
  } catch (error) {
    if (error instanceof JobStopped) {
      jobId = error.jobId;
      stopped = true;
    } else {
      const message =
        error instanceof Error ? error.message : "Contact discovery failed.";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  const response: LeadWithContact[] = leads.map((lead) => ({
    ...lead,
    contactDiscovery: contactByPlaceId.get(lead.placeId) ?? null,
  }));

  return NextResponse.json({ leads: response, jobId, stopped }, { status: 200 });
}