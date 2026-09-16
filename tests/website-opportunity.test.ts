import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/data/db";
import { resetDatabase } from "@/lib/data/schema";
import { createCampaign, linkCampaignLead } from "@/lib/data/campaigns";
import { setLeadPrimaryCampaign, upsertLeadFromDiscovery, type StoredLead } from "@/lib/data/leads";
import type { LeadQualification } from "@/lib/lead-qualification";
import { finalizeLeadQualification, qualifyLeads } from "@/lib/lead-qualification";
import type { Lead } from "@/lib/google-places";
import type { WebsiteOpportunity, WebsiteProbe } from "@/lib/website-opportunity";
import {
  classifyLead,
  classifyLeads,
  discoveryPoolSize,
  selectProspects,
} from "@/lib/website-opportunity";

const originalFetch = globalThis.fetch;

function makeProbe(overrides: Partial<WebsiteProbe> = {}): WebsiteProbe {
  return {
    reached: false,
    functioning: false,
    statusCode: null,
    contentType: null,
    finalUrl: null,
    redirectCount: 0,
    error: null,
    evidence: [],
    ...overrides,
  };
}

function makeGoogleLead(placeId: string, websiteUrl?: string): Lead {
  return {
    placeId,
    businessName: `${placeId} biz`,
    address: "1 Main St",
    googleMapsUrl: `https://maps.google.com/?cid=${placeId}`,
    websiteUrl,
    internationalPhoneNumber: "+10000000000",
    nationalPhoneNumber: undefined,
    rating: 4.5,
    reviewCount: 10,
    businessStatus: "OPERATIONAL",
    primaryType: "plumber",
    types: ["plumber"],
  };
}

function makeGeminiQualification(
  placeId: string,
  overrides: Partial<LeadQualification> = {},
): LeadQualification {
  return {
    opportunityScore: 90,
    qualified: true,
    reason: "Strong niche and location fit.",
    websiteAssessment: "Per deterministic evidence.",
    qualificationStatus: "complete",
    ...overrides,
  };
}

beforeEach(() => {
  resetDatabase(getDb());
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("discoveryPoolSize", () => {
  it("requests at least the lead count and scales by the pool multiplier", () => {
    expect(discoveryPoolSize(1)).toBe(3);
    expect(discoveryPoolSize(5)).toBe(15);
  });

  it("caps at the single-request Places page limit", () => {
    expect(discoveryPoolSize(8)).toBe(20);
    expect(discoveryPoolSize(10)).toBe(20);
    expect(discoveryPoolSize(20)).toBe(20);
    expect(discoveryPoolSize(50)).toBe(20);
    expect(discoveryPoolSize(1000)).toBe(20);
  });
});

describe("classifyLead (pure, no network)", () => {
  it("classifies a lead with no website URL as NO_WEBSITE", () => {
    const assessment = classifyLead(makeGoogleLead("p1"), null);
    expect(assessment.classification).toBe("NO_WEBSITE");
    expect(assessment.url).toBeNull();
    expect(assessment.evidence.join(" ")).toMatch(/no website url/i);
  });

  it("classifies a functioning site as GOOD_WEBSITE", () => {
    const assessment = classifyLead(
      makeGoogleLead("p1", "https://site.example"),
      makeProbe({ reached: true, functioning: true, statusCode: 200, contentType: "text/html", finalUrl: "https://site.example" }),
    );
    expect(assessment.classification).toBe("GOOD_WEBSITE");
    expect(assessment.url).toBe("https://site.example");
  });

  it("classifies an unreachable site as NEEDS_REDESIGN with evidence", () => {
    const assessment = classifyLead(
      makeGoogleLead("p1", "https://down.example"),
      makeProbe({
        reached: false,
        functioning: false,
        statusCode: null,
        error: "fetch failed",
        evidence: ["Website could not be reached: fetch failed"],
      }),
    );
    expect(assessment.classification).toBe("NEEDS_REDESIGN");
    expect(assessment.reached).toBe(false);
    expect(assessment.evidence.length).toBeGreaterThan(0);
  });

  it("classifies an error-status site as NEEDS_REDESIGN", () => {
    const assessment = classifyLead(
      makeGoogleLead("p1", "https://broken.example"),
      makeProbe({ reached: true, functioning: false, statusCode: 500, error: "Website returned error status 500." }),
    );
    expect(assessment.classification).toBe("NEEDS_REDESIGN");
  });

  it("classifies a 404 as NEEDS_REDESIGN", () => {
    const assessment = classifyLead(
      makeGoogleLead("p1", "https://gone.example"),
      makeProbe({ reached: true, functioning: false, statusCode: 404, error: "Website returned error status 404." }),
    );
    expect(assessment.classification).toBe("NEEDS_REDESIGN");
  });

  it("classifies a bot-block status as UNKNOWN, not broken", () => {
    for (const status of [401, 403, 429]) {
      const assessment = classifyLead(
        makeGoogleLead("p1", "https://blocked.example"),
        makeProbe({ reached: true, functioning: false, statusCode: status, error: `Website returned status ${status}.` }),
      );
      expect(assessment.classification).toBe("UNKNOWN");
    }
  });

  it("classifies a safety-blocked website as UNKNOWN", () => {
    const assessment = classifyLead(
      makeGoogleLead("p1", "https://192.168.1.1"),
      makeProbe({
        reached: false,
        functioning: false,
        error: "Blocked address: private IP",
        evidence: ["Website URL is not publicly fetchable: Blocked address: private IP"],
      }),
    );
    expect(assessment.classification).toBe("UNKNOWN");
  });

  it("classifies a non-HTML endpoint with missing probe data as UNKNOWN", () => {
    const assessment = classifyLead(
      makeGoogleLead("p1", "https://api.example"),
      makeProbe({ reached: true, functioning: false, statusCode: 200, contentType: "application/json" }),
    );
    expect(assessment.classification).toBe("UNKNOWN");
  });

  it("classifies a redirect loop as NEEDS_REDESIGN", () => {
    const assessment = classifyLead(
      makeGoogleLead("p1", "https://loop.example"),
      makeProbe({ reached: false, functioning: false, error: "Too many redirects.", redirectCount: 5 }),
    );
    expect(assessment.classification).toBe("NEEDS_REDESIGN");
  });
});

describe("classifyLeads (batch, probe dedupe by URL)", () => {
  it("classifies every lead and probes each distinct website URL once", async () => {
    let probeCalls = 0;
    const fakeProber: (url: string) => Promise<WebsiteProbe> = async () => {
      probeCalls += 1;
      return makeProbe({ reached: true, functioning: true, statusCode: 200, contentType: "text/html" });
    };

    const leadA = makeGoogleLead("p-a", "https://shared.example");
    const leadB = makeGoogleLead("p-b", "https://shared.example");
    const leadC = makeGoogleLead("p-c");

    const results = await classifyLeads([leadA, leadB, leadC], fakeProber);

    expect(probeCalls).toBe(1);
    expect(results.get("p-a")?.classification).toBe("GOOD_WEBSITE");
    expect(results.get("p-b")?.classification).toBe("GOOD_WEBSITE");
    expect(results.get("p-c")?.classification).toBe("NO_WEBSITE");
    expect(results.size).toBe(3);
  });

  it("handles a probe that throws without failing the batch", async () => {
    const fakeProber: (url: string) => Promise<WebsiteProbe> = async () => {
      throw new Error("DNS resolution failed");
    };
    const results = await classifyLeads([makeGoogleLead("p-a", "https://x.example")], fakeProber);
    expect(results.get("p-a")?.classification).toBe("NEEDS_REDESIGN");
  });

  it("returns an empty map for no leads", async () => {
    const results = await classifyLeads([], async () => makeProbe());
    expect(results.size).toBe(0);
  });
});

describe("finalizeLeadQualification (deterministic override)", () => {
  it("keeps a NO_WEBSITE lead qualified when Gemini relevance passes", () => {
    const gemini = makeGeminiQualification("p1");
    const finalized = finalizeLeadQualification(gemini, {
      classification: "NO_WEBSITE",
      url: null,
      reached: false,
      functioning: false,
      statusCode: null,
      contentType: null,
      finalUrl: null,
      evidence: ["No website URL listed by Google Places."],
      probedAt: new Date().toISOString(),
    });
    expect(finalized.qualified).toBe(true);
    expect(finalized.opportunityScore).toBe(90);
    expect(finalized.websiteOpportunity).toBe("NO_WEBSITE");
    expect(finalized.websiteEvidence).toEqual(["No website URL listed by Google Places."]);
  });

  it("forces a GOOD_WEBSITE lead to NOT qualified even when Gemini qualifies it", () => {
    const gemini = makeGeminiQualification("p1", { reason: "Looks great, sell them a site!" });
    const finalized = finalizeLeadQualification(gemini, {
      classification: "GOOD_WEBSITE",
      url: "https://good.example",
      reached: true,
      functioning: true,
      statusCode: 200,
      contentType: "text/html",
      finalUrl: "https://good.example",
      evidence: ["Website reachable with status 200 and serves HTML."],
      probedAt: new Date().toISOString(),
    });
    expect(finalized.qualified).toBe(false);
    expect(finalized.opportunityScore).toBe(0);
    expect(finalized.websiteOpportunity).toBe("GOOD_WEBSITE");
    expect(finalized.reason).toMatch(/functioning website/i);
  });

  it("forces an UNKNOWN lead to NOT qualified even when Gemini qualifies it", () => {
    const finalized = finalizeLeadQualification(makeGeminiQualification("p1"), {
      classification: "UNKNOWN",
      url: "https://shady.example",
      reached: true,
      functioning: false,
      statusCode: 403,
      contentType: null,
      finalUrl: null,
      evidence: ["Website returned status 403; cannot confirm whether it serves a website."],
      probedAt: new Date().toISOString(),
    });
    expect(finalized.qualified).toBe(false);
    expect(finalized.opportunityScore).toBe(0);
    expect(finalized.websiteOpportunity).toBe("UNKNOWN");
  });

  it("keeps a NEEDS_REDESIGN lead qualified when Gemini relevance passes", () => {
    const finalized = finalizeLeadQualification(makeGeminiQualification("p1"), {
      classification: "NEEDS_REDESIGN",
      url: "https://down.example",
      reached: false,
      functioning: false,
      statusCode: null,
      contentType: null,
      finalUrl: null,
      evidence: ["Website could not be reached: fetch failed"],
      probedAt: new Date().toISOString(),
    });
    expect(finalized.qualified).toBe(true);
    expect(finalized.websiteOpportunity).toBe("NEEDS_REDESIGN");
  });

  it("treats a missing assessment as not qualified", () => {
    const finalized = finalizeLeadQualification(makeGeminiQualification("p1"), null);
    expect(finalized.qualified).toBe(false);
    expect(finalized.opportunityScore).toBe(0);
    expect(finalized.websiteOpportunity).toBe("UNKNOWN");
  });

  it("preserves qualificationStatus when classification rides on an unavailable qualification", () => {
    const unavailable: LeadQualification = {
      opportunityScore: 0,
      qualified: false,
      reason: "Qualification is temporarily unavailable.",
      websiteAssessment: "Not assessed",
      qualificationStatus: "unavailable",
    };
    const finalized = finalizeLeadQualification(unavailable, {
      classification: "NO_WEBSITE",
      url: null,
      reached: false,
      functioning: false,
      statusCode: null,
      contentType: null,
      finalUrl: null,
      evidence: ["No website URL listed by Google Places."],
      probedAt: new Date().toISOString(),
    });
    expect(finalized.qualificationStatus).toBe("unavailable");
    expect(finalized.qualified).toBe(false);
    expect(finalized.websiteOpportunity).toBe("NO_WEBSITE");
  });
});

describe("qualifyLeads (assessments injected; Gemini stubbed)", () => {
  function stubGemini(qualifications: Array<{ placeId: string; opportunityScore?: number; qualified?: boolean; reason?: string; websiteAssessment?: string }>) {
    const text = JSON.stringify({ qualifications });
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
      text: async () => "",
    })) as unknown as typeof fetch;
  }

  function assessmentFor(classification: WebsiteOpportunity) {
    return new Map([
      [
        "p1",
        {
          classification,
          url: "https://site.example",
          reached: true,
          functioning: classification === "GOOD_WEBSITE",
          statusCode: classification === "GOOD_WEBSITE" ? 200 : 500,
          contentType: classification === "GOOD_WEBSITE" ? "text/html" : null,
          finalUrl: "https://site.example",
          evidence: [`Evidence for ${classification}`],
          probedAt: new Date().toISOString(),
        },
      ],
    ]);
  }

  it("applies the deterministic override even when Gemini qualifies a GOOD_WEBSITE lead", async () => {
    stubGemini([{ placeId: "p1", opportunityScore: 95, qualified: true, reason: "Great fit", websiteAssessment: "ok" }]);
    const result = await qualifyLeads("Plumbing", "Nowhere", [makeGoogleLead("p1", "https://site.example")], {
      websiteAssessments: assessmentFor("GOOD_WEBSITE"),
    });
    expect(result[0].qualification.qualified).toBe(false);
    expect(result[0].qualification.opportunityScore).toBe(0);
    expect(result[0].qualification.websiteOpportunity).toBe("GOOD_WEBSITE");
  });

  it("keeps a NO_WEBSITE lead qualified when Gemini agrees relevance", async () => {
    stubGemini([{ placeId: "p1", opportunityScore: 85, qualified: true, reason: "Clear no-website fit", websiteAssessment: "none" }]);
    const result = await qualifyLeads("Plumbing", "Nowhere", [makeGoogleLead("p1")], {
      websiteAssessments: assessmentFor("NO_WEBSITE"),
    });
    expect(result[0].qualification.qualified).toBe(true);
    expect(result[0].qualification.websiteOpportunity).toBe("NO_WEBSITE");
  });

  it("forces an UNKNOWN lead to not qualified", async () => {
    stubGemini([{ placeId: "p1", opportunityScore: 88, qualified: true, reason: "Great fit", websiteAssessment: "ok" }]);
    const result = await qualifyLeads("Plumbing", "Nowhere", [makeGoogleLead("p1", "https://site.example")], {
      websiteAssessments: assessmentFor("UNKNOWN"),
    });
    expect(result[0].qualification.qualified).toBe(false);
    expect(result[0].qualification.websiteOpportunity).toBe("UNKNOWN");
  });

  it("falls back to unavailable qualification but still classifies deterministically", async () => {
    stubGemini([]);
    const result = await qualifyLeads("Plumbing", "Nowhere", [makeGoogleLead("p1")], {
      websiteAssessments: assessmentFor("NO_WEBSITE"),
    });
    expect(result[0].qualification.qualificationStatus).toBe("unavailable");
    expect(result[0].qualification.qualified).toBe(false);
    expect(result[0].qualification.websiteOpportunity).toBe("NO_WEBSITE");
  });
});

describe("selectProspects", () => {
  function leadWith(placeId: string, qualification: Partial<LeadQualification>) {
    return {
      ...makeGoogleLead(placeId),
      qualification: {
        ...makeGeminiQualification(placeId, qualification),
        ...qualification,
      },
    };
  }

  it("drops GOOD_WEBSITE and UNKNOWN leads even when they appear qualified", () => {
    const leads = [
      leadWith("good", { qualified: true, opportunityScore: 99, websiteOpportunity: "GOOD_WEBSITE" }),
      leadWith("unknown", { qualified: true, opportunityScore: 99, websiteOpportunity: "UNKNOWN" }),
      leadWith("noweb", { qualified: true, opportunityScore: 70, websiteOpportunity: "NO_WEBSITE" }),
    ];
    const prospects = selectProspects(leads, 10);
    expect(prospects.map((lead) => lead.placeId)).toEqual(["noweb"]);
  });

  it("ranks NO_WEBSITE before NEEDS_REDESIGN regardless of score", () => {
    const leads = [
      leadWith("redesign-high", { qualified: true, opportunityScore: 98, websiteOpportunity: "NEEDS_REDESIGN" }),
      leadWith("noweb-low", { qualified: true, opportunityScore: 60, websiteOpportunity: "NO_WEBSITE" }),
    ];
    const prospects = selectProspects(leads, 10);
    expect(prospects.map((lead) => lead.placeId)).toEqual(["noweb-low", "redesign-high"]);
  });

  it("ties within a class by score descending", () => {
    const leads = [
      leadWith("low", { qualified: true, opportunityScore: 60, websiteOpportunity: "NO_WEBSITE" }),
      leadWith("high", { qualified: true, opportunityScore: 90, websiteOpportunity: "NO_WEBSITE" }),
      leadWith("mid", { qualified: true, opportunityScore: 80, websiteOpportunity: "NO_WEBSITE" }),
    ];
    expect(selectProspects(leads, 3).map((lead) => lead.placeId)).toEqual(["high", "mid", "low"]);
  });

  it("returns fewer prospects than requested rather than padding with good websites", () => {
    const leads = [
      ...Array.from({ length: 47 }, (_, i) =>
        leadWith(`good-${i}`, { qualified: true, opportunityScore: 95, websiteOpportunity: "GOOD_WEBSITE" }),
      ),
      leadWith("noweb-1", { qualified: true, opportunityScore: 80, websiteOpportunity: "NO_WEBSITE" }),
      leadWith("noweb-2", { qualified: true, opportunityScore: 70, websiteOpportunity: "NO_WEBSITE" }),
      leadWith("redesign-1", { qualified: true, opportunityScore: 75, websiteOpportunity: "NEEDS_REDESIGN" }),
    ];

    // A 50-request campaign that only finds 3 genuine opportunities returns 3.
    const prospects = selectProspects(leads, 50);
    expect(prospects).toHaveLength(3);
    expect(prospects.every((lead) => lead.qualification.websiteOpportunity !== "GOOD_WEBSITE")).toBe(true);
    expect(prospects.map((lead) => lead.placeId)).toEqual(["noweb-1", "noweb-2", "redesign-1"]);
  });

  it("applies the limit when more genuine opportunities exist", () => {
    const leads = [
      leadWith("a", { qualified: true, opportunityScore: 90, websiteOpportunity: "NO_WEBSITE" }),
      leadWith("b", { qualified: true, opportunityScore: 80, websiteOpportunity: "NO_WEBSITE" }),
      leadWith("c", { qualified: true, opportunityScore: 70, websiteOpportunity: "NO_WEBSITE" }),
    ];
    expect(selectProspects(leads, 2)).toHaveLength(2);
    expect(selectProspects(leads, 0)).toHaveLength(0);
    expect(selectProspects([], 5)).toHaveLength(0);
  });
});

describe("place-id duplicate/history integrity with classification", () => {
  function storedProspect(placeId: string, qualification: LeadQualification) {
    return {
      ...makeGoogleLead(placeId, qualification.websiteUrlChecked ?? undefined),
      qualification,
    };
  }

  it("replaces a stored qualification on rediscovery when updateExisting is true", () => {
    const first = upsertLeadFromDiscovery(
      storedProspect("place-1", {
        ...makeGeminiQualification("place-1"),
        websiteOpportunity: "NO_WEBSITE",
        qualified: true,
      }),
      { updateExisting: true },
    );
    expect(first.created).toBe(true);

    const second = upsertLeadFromDiscovery(
      storedProspect("place-1", {
        ...makeGeminiQualification("place-1"),
        qualified: false,
        opportunityScore: 0,
        reason: "Excluded: business already has a functioning website.",
        websiteOpportunity: "GOOD_WEBSITE",
        websiteEvidence: ["Website reachable with status 200 and serves HTML."],
        websiteUrlChecked: "https://site.example",
      }),
      { updateExisting: true },
    );
    expect(second.created).toBe(false);
    expect(second.lead.id).toBe(first.lead.id);
    expect(second.lead.qualification?.websiteOpportunity).toBe("GOOD_WEBSITE");
    expect(second.lead.qualification?.qualified).toBe(false);

    const rows = getDb().prepare("SELECT COUNT(*) AS c FROM leads WHERE place_id = ?").get("place-1") as { c: number };
    expect(Number(rows.c)).toBe(1);
  });

  it("keeps the stored qualification when updateExisting is false", () => {
    const campaign = createCampaign({ niche: "Plumbing", location: "Nowhere", requestedLeadCount: 5, status: "ok" });
    const first = upsertLeadFromDiscovery(
      storedProspect("place-2", {
        ...makeGeminiQualification("place-2"),
        websiteOpportunity: "NO_WEBSITE",
        qualified: true,
      }),
      { updateExisting: false },
    );
    setLeadPrimaryCampaign(first.lead.id, campaign.id);

    const second = upsertLeadFromDiscovery(
      storedProspect("place-2", {
        ...makeGeminiQualification("place-2"),
        qualified: false,
        opportunityScore: 0,
        websiteOpportunity: "GOOD_WEBSITE",
      }),
      { updateExisting: false },
    );
    expect(second.lead.id).toBe(first.lead.id);
    expect(second.lead.qualification?.websiteOpportunity).toBe("NO_WEBSITE");
    expect(second.lead.qualification?.qualified).toBe(true);
  });

  it("does not create duplicate lead rows across rediscovery", async () => {
    const campaign = createCampaign({ niche: "Plumbing", location: "Nowhere", requestedLeadCount: 5, status: "ok" });
    let stored: StoredLead | null = null;

    for (let i = 0; i < 3; i += 1) {
      const result = upsertLeadFromDiscovery(
        storedProspect("place-3", {
          ...makeGeminiQualification("place-3", { qualified: i === 0 }),
          websiteOpportunity: i === 0 ? "NO_WEBSITE" : "GOOD_WEBSITE",
          qualified: i === 0,
        }),
        { updateExisting: true },
      );
      stored = result.lead;
    }

    expect(stored).not.toBeNull();
    linkCampaignLead(campaign.id, stored!.id);
    const rows = getDb().prepare("SELECT COUNT(*) AS c FROM leads WHERE place_id = ?").get("place-3") as { c: number };
    expect(Number(rows.c)).toBe(1);

    const campaignIds = getDb()
      .prepare("SELECT campaign_id FROM campaign_leads WHERE lead_id = ?")
      .all(stored!.id);
    expect(campaignIds).toHaveLength(1);
  });
});