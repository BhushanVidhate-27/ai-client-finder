/**
 * Deterministic source generation for the Website Coding Agent.
 *
 * The agent never "writes whatever it likes": the site source is rendered from
 * the approved website specification (WebsiteBlueprint) when one is supplied,
 * otherwise from a minimal blueprint derived only from verified research. The
 * existing deterministic renderer (website-builder / website-render) is reused
 * so the output is exactly what the rest of the app renders — no invented
 * facts, no lorem ipsum, no fabricated contact details.
 */

import type { QualifiedLead } from "@/lib/lead-qualification";
import type { WebsiteResearch } from "@/lib/lead-research";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import type {
  WebsiteBlueprint,
  WebsiteProject,
  WebsiteProjectFile,
  ProjectPage,
  DesignSystem,
} from "@/lib/website-project";
import {
  buildProject,
  normalizeBlueprint,
  parseBlueprint,
  slugify,
} from "@/lib/website-builder";

export interface CoderProspectInput {
  lead: QualifiedLead;
  research: WebsiteResearch;
  contact?: ContactDiscovery | null;
  /** Approved specification when available; otherwise derived from research. */
  blueprint?: WebsiteBlueprint | null;
}

export interface RenderedSiteFile {
  path: string;
  contentType: string;
  content: string;
}

export interface RenderedSite {
  project: WebsiteProject;
  /** Source files the build requires to exist (pages, css, js, package.json). */
  files: RenderedSiteFile[];
  /** Relative paths that must be present for a build to pass. */
  requiredFiles: string[];
}

/** Maps a research "visual direction" hint to a tasteful fixed palette. */
function designFromDirection(visualDirection: string): DesignSystem {
  const v = visualDirection.toLowerCase();
  const rationales: Record<string, string> = {
    warm: "Earthy, accessible palette and friendly typography.",
    minimal: "Quiet, clean palette emphasizing content and contrast.",
    bold: "Confident, energetic palette with strong contrast.",
    modern: "Modern, trustworthy palette with clear hierarchy.",
  };

  if (/warm|rustic|cozy|classic|traditional|earthy|inviting/.test(v)) {
    return {
      palette: {
        primary: "#b45309",
        accent: "#4d7c0f",
        background: "#fffdf8",
        surface: "#f6efe3",
        text: "#292524",
        muted: "#78716c",
      },
      typography: { headingFont: "Lora", bodyFont: "Inter", style: "Warm and modern" },
      spacing: "Generous",
      layout: "Single column",
      aesthetic: "Warm",
      rationale: rationales.warm,
    };
  }
  if (/bold|vibrant|energetic|playful|modern.*bright/.test(v)) {
    return {
      palette: {
        primary: "#4f46e5",
        accent: "#db2777",
        background: "#ffffff",
        surface: "#eef2ff",
        text: "#0f172a",
        muted: "#64748b",
      },
      typography: { headingFont: "Inter", bodyFont: "Inter", style: "Bold and modern" },
      spacing: "Generous",
      layout: "Single column",
      aesthetic: "Bold",
      rationale: rationales.bold,
    };
  }
  if (/minimal|clean|scandinavian|simple|crisp/.test(v)) {
    return {
      palette: {
        primary: "#334155",
        accent: "#0e7490",
        background: "#ffffff",
        surface: "#f1f5f9",
        text: "#0f172a",
        muted: "#64748b",
      },
      typography: { headingFont: "Inter", bodyFont: "Inter", style: "Minimal" },
      spacing: "Comfortable",
      layout: "Single column",
      aesthetic: "Minimal",
      rationale: rationales.minimal,
    };
  }
  return {
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
    aesthetic: "Modern",
    rationale: rationales.modern,
  };
}

/**
 * Builds a minimal WebsiteBlueprint purely from verified research and the
 * qualified lead. Used only when no blueprint was supplied.
 */
export function blueprintFromResearch(
  input: CoderProspectInput,
): WebsiteBlueprint {
  const { lead, research, contact } = input;
  const businessName = lead.businessName.trim() || "Our business";
  const location =
    research.location.trim() || lead.address.trim() || "your area";
  const overview = research.businessSummary.trim();

  const services = research.services
    .slice(0, 8)
    .map((sv) => ({ title: sv.trim(), body: `Provided by ${businessName} in ${location}.` }));

  const hasContact = Boolean(
    contact?.email || contact?.phone || lead.internationalPhoneNumber || lead.nationalPhoneNumber || lead.address,
  );

  const pages: ProjectPage[] = [];

  const homeSections: ProjectPage["sections"] = [];
  if (services.length > 0) {
    homeSections.push({
      kind: "services",
      heading: "Services",
      body: `What ${businessName} offers in ${location}.`,
      items: services.map((s) => ({ title: s.title, body: s.body })),
    });
  }
  if (overview) {
    homeSections.push({
      kind: "about",
      heading: `About ${businessName}`,
      body: overview,
    });
  }

  pages.push({
    path: "/",
    navLabel: "Home",
    title: `${businessName} — ${location}`,
    description: overview || `${businessName} in ${location}.`,
    hero: {
      eyebrow: location,
      heading: businessName,
      subheading: overview || `Trusted services in ${location}.`,
    },
    sections: homeSections,
    hasContactSection: hasContact,
  });

  if (services.length > 0) {
    pages.push({
      path: "/services",
      navLabel: "Services",
      title: `Services — ${businessName}`,
      description: `Services provided by ${businessName} in ${location}.`,
      hero: {
        eyebrow: "Services",
        heading: "What we do",
        subheading: overview || `Services in ${location}.`,
      },
      sections: [
        {
          kind: "features",
          heading: "Services",
          body: "",
          items: services.map((s) => ({ title: s.title, body: s.body })),
        },
      ],
      hasContactSection: false,
    });
  }

  if (hasContact && (contact?.email || contact?.phone)) {
    pages.push({
      path: "/contact",
      navLabel: "Contact",
      title: `Contact ${businessName}`,
      description: `Get in touch with ${businessName}.`,
      hero: {
        eyebrow: "Contact",
        heading: "Get in touch",
        subheading: research.primaryCTA || `Reach ${businessName} today.`,
      },
      sections: [],
      hasContactSection: true,
    });
  }

  const placeholders: Array<{ field: string; replacement: string }> = [];
  const unknowns = [...research.unknowns];
  if (!contact?.email) {
    placeholders.push({ field: "email", replacement: "Email unavailable" });
    unknowns.push("Email address is not verified.");
  }
  if (!contact?.phone) {
    placeholders.push({ field: "phone", replacement: "Phone number unavailable" });
    unknowns.push("Phone number is not verified.");
  }

  return {
    tagline: overview || `${businessName} in ${location}`,
    overview,
    targetAudience: research.targetAudience.trim() || "local customers",
    locationLabel: location,
    services,
    primaryCta: {
      label: research.primaryCTA.trim() || "Contact us",
      subtext: overview || `Learn more about ${businessName} in ${location}.`,
    },
    designSystem: designFromDirection(research.visualDirection),
    pages,
    contact: {
      email: contact?.email ?? null,
      phone: lead.internationalPhoneNumber ?? lead.nationalPhoneNumber ?? contact?.phone ?? null,
      address: lead.address.trim() || null,
      mapsUrl: lead.googleMapsUrl || null,
      websiteUrl: lead.websiteUrl ?? null,
    },
    footerNote: `${businessName} · ${location}`,
    sourceFacts: [
      ...research.verifiedFacts,
      `${businessName} is located in ${location}.`,
    ],
    unknowns,
    placeholders,
  };
}

function buildPackageJson(slug: string, businessName: string): string {
  return JSON.stringify(
    {
      name: slug,
      version: "0.1.0",
      private: true,
      description: `Static website for ${businessName}.`,
      scripts: {},
    },
    null,
    2,
  );
}

/**
 * Renders the full set of workspace source files for a prospect. Prefers the
 * supplied (sanitized) blueprint; falls back to verified research only.
 */
export function renderSiteSource(
  input: CoderProspectInput,
  projectId: string,
): RenderedSite {
  const leadName = input.lead.businessName.trim() || "Business";
  const slug = slugify(leadName) || slugify(projectId) || "site";

  let blueprint = input.blueprint ? parseBlueprint(input.blueprint) : null;
  if (!blueprint) blueprint = blueprintFromResearch(input);
  normalizeBlueprint(blueprint);

  const artifactId = slugify(projectId) || `site_${slug}`;
  const project = buildProject(artifactId, leadName, slug, blueprint);

  const files: RenderedSiteFile[] = project.files.map((file: WebsiteProjectFile) => ({
    path: file.path,
    contentType: file.contentType,
    content: file.content,
  }));
  files.push({
    path: "package.json",
    contentType: "application/json",
    content: buildPackageJson(slug, leadName),
  });

  return {
    project,
    files,
    requiredFiles: files.map((file) => file.path),
  };
}

/** Derives a safe workspace project id from references when one is missing. */
export function resolveProjectId(input: {
  explicit?: unknown;
  lead?: { businessName?: string } | null;
}): string {
  if (typeof input.explicit === "string" && input.explicit.trim()) {
    const candidate = slugify(input.explicit);
    if (candidate) return candidate;
  }
  const fallback = slugify(input.lead?.businessName ?? "project");
  return fallback || "project";
}