import type { Lead } from "@/lib/google-places";
import type {
  WebsiteOpportunity,
  WebsiteOpportunityAssessment,
} from "@/lib/website-opportunity";
import { classifyLeads } from "@/lib/website-opportunity";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent";

export interface LeadQualification {
  opportunityScore: number;
  qualified: boolean;
  reason: string;
  websiteAssessment: string;
  qualificationStatus: "complete" | "unavailable";
  /**
   * Deterministic website-opportunity classification (NO_WEBSITE /
   * NEEDS_REDESIGN / GOOD_WEBSITE / UNKNOWN). This is authoritative and is
   * what the final qualification decision is derived from.
   */
  websiteOpportunity?: WebsiteOpportunity;
  /** Deterministic evidence backing the websiteOpportunity classification. */
  websiteEvidence?: string[];
  /** The website URL that was inspected, when one was present. */
  websiteUrlChecked?: string | null;
}

export type QualifiedLead = Lead & { qualification: LeadQualification };

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

type ModelQualification = {
  placeId?: unknown;
  opportunityScore?: unknown;
  qualified?: unknown;
  reason?: unknown;
  websiteAssessment?: unknown;
};

function unavailableQualification(reason: string): LeadQualification {
  return {
    opportunityScore: 0,
    qualified: false,
    reason,
    websiteAssessment: "Not assessed",
    qualificationStatus: "unavailable",
  };
}

/**
 * Applies the deterministic qualification rules on top of whatever Gemini
 * returned. Gemini decides niche/location/business relevance, but the final
 * `qualified` decision is derived from the authoritative website evidence:
 *
 *   GOOD_WEBSITE -> never qualified.
 *   UNKNOWN      -> never qualified (insufficient evidence).
 *   NO_WEBSITE   -> qualified only when Gemini's relevance check passes.
 *   NEEDS_REDESIGN -> qualified only when Gemini's relevance check passes
 *                     AND the deterministic evidence supports a redesign
 *                     (NEEDS_REDESIGN is only ever assigned with evidence).
 *
 * A business with a good existing website can therefore never be turned into
 * a qualified prospect by Gemini (or anything else).
 */
export function finalizeLeadQualification(
  qualification: LeadQualification,
  assessment: WebsiteOpportunityAssessment | null,
): LeadQualification {
  const opportunity = assessment?.classification ?? null;

  // No assessment at all: cannot confirm anything, so never a prospect.
  if (!assessment) {
    return {
      ...qualification,
      opportunityScore: 0,
      qualified: false,
      reason: `Excluded: website status is not determinable. ${qualification.reason ?? ""}`.trim(),
      websiteOpportunity: "UNKNOWN",
      websiteEvidence: ["No website evidence available."],
      websiteUrlChecked: null,
    };
  }

  if (opportunity === "NO_WEBSITE") {
    return {
      ...qualification,
      websiteOpportunity: "NO_WEBSITE",
      websiteEvidence: assessment.evidence,
      websiteUrlChecked: assessment.url,
    };
  }

  if (opportunity === "NEEDS_REDESIGN") {
    // Needs redesign is only ever assigned with deterministic evidence, so an
    // explicit database "evidence unchanged" guard is implicit. Keep relevance.
    return {
      ...qualification,
      websiteOpportunity: "NEEDS_REDESIGN",
      websiteEvidence: assessment.evidence,
      websiteUrlChecked: assessment.url,
    };
  }

  if (opportunity === "GOOD_WEBSITE") {
    return {
      ...qualification,
      opportunityScore: 0,
      qualified: false,
      reason: `Excluded: business already has a functioning website. ${qualification.reason ?? ""}`.trim(),
      websiteAssessment: "A working website is already present.",
      websiteOpportunity: "GOOD_WEBSITE",
      websiteEvidence: assessment.evidence,
      websiteUrlChecked: assessment.url,
    };
  }

  // UNKNOWN classification: not a qualified prospect by default.
  return {
    ...qualification,
    opportunityScore: 0,
    qualified: false,
    reason: `Excluded: website status is unknown and cannot be verified. ${qualification.reason ?? ""}`.trim(),
    websiteOpportunity: "UNKNOWN",
    websiteEvidence: assessment.evidence,
    websiteUrlChecked: assessment.url,
  };
}

const qualificationSchema = {
  type: "object",
  properties: {
    qualifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          placeId: { type: "string" },
          opportunityScore: { type: "integer", minimum: 0, maximum: 100 },
          qualified: { type: "boolean" },
          reason: { type: "string" },
          websiteAssessment: { type: "string" },
        },
        required: ["placeId", "opportunityScore", "qualified", "reason", "websiteAssessment"],
      },
    },
  },
  required: ["qualifications"],
};

function buildPrompt(
  niche: string,
  location: string,
  leads: Lead[],
  assessments: Map<string, WebsiteOpportunityAssessment>,
) {
  const scoredLeads = leads.map((lead) => {
    const assessment = assessments.get(lead.placeId);
    const websiteOpportunity = assessment?.classification ?? "UNKNOWN";
    const websiteEvidence = assessment?.evidence ?? [];
    return {
      placeId: lead.placeId,
      businessName: lead.businessName,
      address: lead.address,
      rating: lead.rating,
      reviewCount: lead.reviewCount,
      businessStatus: lead.businessStatus,
      primaryType: lead.primaryType,
      types: lead.types,
      websiteUrl: lead.websiteUrl ?? null,
      websiteOpportunity,
      websiteEvidence,
    };
  });

  const rules = [
    "You are a careful B2B website-sales qualification agent.",
    `Requested niche: ${niche}`,
    `Requested location: ${location}`,
    "Assess niche and location relevance from the full record; never automatically trust the name, category, or search query.",
    "Prefer legitimate operational businesses with active local presence, meaningful reviews, clear niche fit.",
    "The websiteOpportunity field for each lead is DETERMINISTIC and AUTHORITATIVE. Never change it. It describes the business's existing website evidence.",
    "For websiteOpportunity = GOOD_WEBSITE or UNKNOWN you must return qualified=false and opportunityScore=0: such businesses are not sales opportunities.",
    "For websiteOpportunity = NO_WEBSITE, qualify (qualified=true, score 60+) ONLY when niche and location relevance clearly pass.",
    "For websiteOpportunity = NEEDS_REDESIGN, qualify (qualified=true, score 60+) ONLY when the deterministic website evidence already shows the website is poor or broken, AND niche/location relevance passes.",
    "Do NOT invent website problems. websiteAssessment must summarize ONLY the deterministic websiteEvidence provided.",
    "Reject obvious mismatches, closed businesses, and leads with insufficient evidence.",
    "Keep reason and websiteAssessment concise. Return one result per placeId and no commentary.",
  ].join("\n");

  return `${rules}\n\nLeads:\n${JSON.stringify(scoredLeads)}`;
}

function parseQualification(value: ModelQualification): LeadQualification | null {
  if (
    typeof value.opportunityScore !== "number" ||
    !Number.isInteger(value.opportunityScore) ||
    value.opportunityScore < 0 ||
    value.opportunityScore > 100 ||
    typeof value.qualified !== "boolean" ||
    typeof value.reason !== "string" ||
    typeof value.websiteAssessment !== "string"
  ) return null;

  return {
    opportunityScore: value.opportunityScore,
    qualified: value.qualified,
    reason: value.reason.slice(0, 240),
    websiteAssessment: value.websiteAssessment.slice(0, 180),
    qualificationStatus: "complete",
  };
}

export interface QualifyLeadsOptions {
  /**
   * Precomputed deterministic website assessments, keyed by placeId. When
   * omitted, assessments are computed here (real network probes). Tests can
   * inject a fixed map to avoid network access.
   */
  websiteAssessments?: Map<string, WebsiteOpportunityAssessment>;
}

/**
 * Qualifies a batch of discovered leads. Website opportunity is classified
 * deterministically (NO_WEBSITE / NEEDS_REDESIGN / GOOD_WEBSITE / UNKNOWN)
 * and treated as authoritative. Gemini reasons about niche/location/business
 * relevance only; finalizeLeadQualification then forces GOOD_WEBSITE and
 * UNKNOWN to qualified=false regardless of what Gemini returned.
 */
export async function qualifyLeads(
  niche: string,
  location: string,
  leads: Lead[],
  options?: QualifyLeadsOptions,
): Promise<QualifiedLead[]> {
  const assessments =
    options?.websiteAssessments ?? (await classifyLeads(leads));

  const attach = (lead: Lead, qualification: LeadQualification): QualifiedLead => ({
    ...lead,
    qualification: finalizeLeadQualification(
      qualification,
      assessments.get(lead.placeId) ?? null,
    ),
  });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return leads.map((lead) =>
      attach(
        lead,
        unavailableQualification(
          "Qualification is unavailable because the Gemini API key is not configured.",
        ),
      ),
    );
  }

  try {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(niche, location, leads, assessments) }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: qualificationSchema, temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(30 * 1000),
    });
    if (!response.ok) throw new Error(`Gemini returned ${response.status}.`);

    const data: GeminiResponse = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned no qualification data.");

    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { qualifications?: unknown }).qualifications)) {
      throw new Error("Gemini returned an invalid qualification response.");
    }

    const results = new Map<string, LeadQualification>();
    for (const item of (parsed as { qualifications: ModelQualification[] }).qualifications) {
      if (typeof item.placeId === "string") {
        const qualification = parseQualification(item);
        if (qualification) results.set(item.placeId, qualification);
      }
    }

    return leads.map((lead) =>
      attach(
        lead,
        results.get(lead.placeId) ?? unavailableQualification("Gemini did not return a qualification for this lead."),
      ),
    );
  } catch (error) {
    console.error("[lead-qualification] Gemini qualification failed:", error);
    return leads.map((lead) =>
      attach(
        lead,
        unavailableQualification("Qualification is temporarily unavailable. Google Places results are still shown."),
      ),
    );
  }
}
