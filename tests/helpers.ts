import type { QualifiedLead, LeadQualification } from "@/lib/lead-qualification";
import type { WebsiteResearch } from "@/lib/lead-research";
import type { WebsiteProject } from "@/lib/website-project";

export function makeQualification(): LeadQualification {
  return {
    opportunityScore: 80,
    qualified: true,
    reason: "Fixture",
    websiteAssessment: "Outdated",
    qualificationStatus: "complete",
  };
}

export function makeLead(placeId: string, businessName = `${placeId} biz`): QualifiedLead {
  return {
    placeId,
    businessName,
    address: "1 Main St",
    googleMapsUrl: `https://maps.google.com/?cid=${placeId}`,
    websiteUrl: "https://example.com",
    internationalPhoneNumber: "+10000000000",
    nationalPhoneNumber: undefined,
    rating: 4.5,
    reviewCount: 10,
    businessStatus: "OPERATIONAL",
    primaryType: "plumber",
    types: ["plumber", "home_goods_store"],
    qualification: makeQualification(),
  };
}

export function makeResearch(): WebsiteResearch {
  return {
    businessSummary: "Fixture business.",
    services: ["Repairs"],
    targetAudience: "Homeowners",
    location: "Nowhere",
    brandObservations: [],
    existingWebsiteAssessment: "None",
    suggestedPages: ["/", "/contact"],
    suggestedSections: ["about"],
    primaryCTA: "Call us",
    copyDirection: "Friendly",
    visualDirection: "Clean",
    verifiedFacts: ["Located at 1 Main St"],
    unknowns: [],
    sources: ["https://example.com"],
  };
}

export function makeProject(overrides?: Partial<WebsiteProject>): WebsiteProject {
  const projectId = overrides?.projectId ?? "site_fixture";
  const base: WebsiteProject = {
    projectId,
    businessName: "Fixture Biz",
    slug: "fixture-biz",
    status: "completed",
    generatedAt: new Date().toISOString(),
    pages: [
      {
        path: "/",
        navLabel: "Home",
        title: "Fixture Biz",
        description: "A fixture business.",
        hero: { eyebrow: "Hi", heading: "Welcome", subheading: "Great work" },
        sections: [],
        hasContactSection: true,
      },
    ],
    files: [],
    generatedCopy: [{ key: "home.hero.heading", text: "Welcome" }],
    designDirection: {
      palette: {
        primary: "#2563eb",
        accent: "#16a34a",
        background: "#ffffff",
        surface: "#f8fafc",
        text: "#0f172a",
        muted: "#64748b",
      },
      typography: { headingFont: "Inter", bodyFont: "Inter", style: "Modern" },
      spacing: "Generous",
      layout: "Single column",
      aesthetic: "Clean",
      rationale: "Fixture",
    },
    primaryCta: { label: "Contact us", subtext: "Get in touch", targetPage: "/contact" },
    contact: {
      email: null,
      phone: null,
      address: "1 Main St",
      mapsUrl: null,
      websiteUrl: null,
    },
    footerNote: "Fixture footer.",
    sourceFacts: ["Located at 1 Main St"],
    unknowns: [],
    placeholders: [],
  };
  return { ...base, ...overrides };
}