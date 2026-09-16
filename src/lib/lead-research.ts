import type { QualifiedLead } from "@/lib/lead-qualification";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import { JobStoppedError } from "@/lib/jobs/controller";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent";

const MAX_ITEMS_PER_ARRAY = 10;
const MAX_FIELD_LENGTH = 500;

export interface WebsiteResearch {
  businessSummary: string;
  services: string[];
  targetAudience: string;
  location: string;
  brandObservations: string[];
  existingWebsiteAssessment: string;
  suggestedPages: string[];
  suggestedSections: string[];
  primaryCTA: string;
  copyDirection: string;
  visualDirection: string;
  verifiedFacts: string[];
  unknowns: string[];
  sources: string[];
}

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

type ModelResearch = {
  businessSummary?: unknown;
  services?: unknown;
  targetAudience?: unknown;
  location?: unknown;
  brandObservations?: unknown;
  existingWebsiteAssessment?: unknown;
  suggestedPages?: unknown;
  suggestedSections?: unknown;
  primaryCTA?: unknown;
  copyDirection?: unknown;
  visualDirection?: unknown;
  verifiedFacts?: unknown;
  unknowns?: unknown;
  sources?: unknown;
};

const researchSchema = {
  type: "object",
  properties: {
    businessSummary: { type: "string" },
    services: { type: "array", items: { type: "string" } },
    targetAudience: { type: "string" },
    location: { type: "string" },
    brandObservations: { type: "array", items: { type: "string" } },
    existingWebsiteAssessment: { type: "string" },
    suggestedPages: { type: "array", items: { type: "string" } },
    suggestedSections: { type: "array", items: { type: "string" } },
    primaryCTA: { type: "string" },
    copyDirection: { type: "string" },
    visualDirection: { type: "string" },
    verifiedFacts: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "string" } },
    sources: { type: "array", items: { type: "string" } },
  },
  required: [
    "businessSummary",
    "services",
    "targetAudience",
    "location",
    "brandObservations",
    "existingWebsiteAssessment",
    "suggestedPages",
    "suggestedSections",
    "primaryCTA",
    "copyDirection",
    "visualDirection",
    "verifiedFacts",
    "unknowns",
    "sources",
  ],
};

function buildEvidence(
  lead: QualifiedLead,
  contact: ContactDiscovery | null,
): Record<string, unknown> {
  const evidence: Record<string, unknown> = {
    businessName: lead.businessName,
    address: lead.address,
    rating: lead.rating ?? null,
    reviewCount: lead.reviewCount ?? null,
    businessStatus: lead.businessStatus ?? null,
    primaryType: lead.primaryType ?? null,
    types: lead.types ?? [],
    googleMapsUrl: lead.googleMapsUrl || null,
    websiteUrl: lead.websiteUrl ?? null,
    phone: lead.internationalPhoneNumber ?? lead.nationalPhoneNumber ?? null,
    opportunityScore: lead.qualification.opportunityScore,
    qualificationReason: lead.qualification.reason,
  };

  if (contact) {
    evidence.contactEmail = contact.email;
    evidence.contactEmailSourceUrl = contact.emailSourceUrl;
    evidence.contactPhone = contact.phone;
    evidence.contactPhoneSourceUrl = contact.phoneSourceUrl;
  }

  return evidence;
}

function buildPrompt(
  lead: QualifiedLead,
  contact: ContactDiscovery | null,
): string {
  const rules = [
    "You are a careful website-specification researcher for a single business.",
    "Produce a structured website specification that a separate Website Builder agent will use to build a real website for this business.",
    "STRICT RULES:",
    "1. Never invent business facts. Use ONLY the provided evidence below.",
    "2. businessSummary, services, targetAudience, location, brandObservations, and verifiedFacts must be observations strictly derived from the provided evidence.",
    "3. If a fact is not present in the evidence, do not assume it. List it in unknowns instead.",
    "4. Do not claim the business offers a service unless there is direct evidence (primaryType, types, or a provided source).",
    "5. existingWebsiteAssessment: describe ONLY the actual website when websiteUrl is provided and accessible. If websiteUrl is null, set it to exactly: No official website found.",
    "6. suggestedPages, suggestedSections, primaryCTA, copyDirection, and visualDirection are forward-looking RECOMMENDATIONS for the future website. They are not claims about the current business.",
    "7. Every entry in verifiedFacts must be a concise factual statement directly supported by the provided evidence.",
    "8. sources must contain ONLY URLs that appear in the provided evidence (googleMapsUrl, websiteUrl, contactEmailSourceUrl, contactPhoneSourceUrl). Never guess URLs.",
    "9. Keep each text field to 1–3 sentences and each array item short (under 80 characters). Never exceed 10 items per array.",
    "10. Use \"Unknown\" (or similar) when a field cannot be determined from the evidence.",
  ].join("\n");

  return `${rules}\n\nEvidence:\n${JSON.stringify(buildEvidence(lead, contact), null, 2)}`;
}

function clampArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const cleaned: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().slice(0, MAX_FIELD_LENGTH);
    if (trimmed) cleaned.push(trimmed);
    if (cleaned.length >= limit) break;
  }
  return cleaned;
}

function toStringField(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_FIELD_LENGTH) : "Unknown";
}

function parseResearch(value: ModelResearch): WebsiteResearch | null {
  for (const key of [
    "businessSummary",
    "targetAudience",
    "location",
    "existingWebsiteAssessment",
    "primaryCTA",
    "copyDirection",
    "visualDirection",
  ] as const) {
    if (typeof value[key] !== "string") return null;
  }

  return {
    businessSummary: toStringField(value.businessSummary),
    services: clampArray(value.services, MAX_ITEMS_PER_ARRAY),
    targetAudience: toStringField(value.targetAudience),
    location: toStringField(value.location),
    brandObservations: clampArray(value.brandObservations, MAX_ITEMS_PER_ARRAY),
    existingWebsiteAssessment: toStringField(value.existingWebsiteAssessment),
    suggestedPages: clampArray(value.suggestedPages, MAX_ITEMS_PER_ARRAY),
    suggestedSections: clampArray(value.suggestedSections, MAX_ITEMS_PER_ARRAY),
    primaryCTA: toStringField(value.primaryCTA),
    copyDirection: toStringField(value.copyDirection),
    visualDirection: toStringField(value.visualDirection),
    verifiedFacts: clampArray(value.verifiedFacts, MAX_ITEMS_PER_ARRAY),
    unknowns: clampArray(value.unknowns, MAX_ITEMS_PER_ARRAY),
    sources: clampArray(value.sources, 15),
  };
}

function failed(placeId: string, errorMessage: string) {
  return {
    placeId,
    status: "failed" as const,
    websiteResearch: null,
    errorMessage,
  };
}

export async function researchLead(
  lead: QualifiedLead,
  contact: ContactDiscovery | null,
) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return failed(lead.placeId, "Gemini API key is not configured.");
  }

  try {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(lead, contact) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: researchSchema,
          temperature: 0.4,
        },
      }),
      signal: AbortSignal.timeout(30 * 1000),
    });
    if (!response.ok) throw new Error(`Gemini returned ${response.status}.`);

    const data: GeminiResponse = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned no research data.");

    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Gemini returned an invalid research response.");
    }

    const research = parseResearch(parsed as ModelResearch);
    if (!research) {
      throw new Error("Gemini returned an incomplete research response.");
    }

    return {
      placeId: lead.placeId,
      status: "complete" as const,
      websiteResearch: research,
      errorMessage: null,
    };
  } catch (error) {
    console.error("[lead-research] Gemini research failed:", error);
    return failed(lead.placeId, "Research is temporarily unavailable.");
  }
}

export interface ResearchResult {
  placeId: string;
  status: "complete" | "failed";
  websiteResearch: WebsiteResearch | null;
  errorMessage: string | null;
}

export interface ResearchHooks {
  beforeLead?: (lead: QualifiedLead, index: number) => Promise<void> | void;
  afterLead?: (lead: QualifiedLead, result: ResearchResult) => Promise<void> | void;
}

export async function researchLeads(
  leads: QualifiedLead[],
  contactByPlaceId: Map<string, ContactDiscovery | null | undefined>,
  concurrency = 3,
  hooks?: ResearchHooks,
) {
  const results = new Array<ResearchResult>(leads.length);
  let nextIndex = 0;
  let stopped = false;

  const worker = async () => {
    while (!stopped && nextIndex < leads.length) {
      const index = nextIndex;
      nextIndex += 1;
      const lead = leads[index];
      try {
        await hooks?.beforeLead?.(lead, index);
        const contact = contactByPlaceId.get(lead.placeId) ?? null;
        const result = await researchLead(lead, contact);
        results[index] = result;
        await hooks?.afterLead?.(lead, result);
      } catch (error) {
        if (error instanceof JobStoppedError) {
          stopped = true;
        } else {
          results[index] = failed(
            lead.placeId,
            "Research is temporarily unavailable.",
          );
        }
      }
    }
  };

  const workerCount = Math.min(concurrency, leads.length);
  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  return results;
}