import { callGemini } from "@/lib/gemini";
import type { QualifiedLead } from "@/lib/lead-qualification";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import type { WebsiteResearch } from "@/lib/lead-research";
import type {
  WebsiteBlueprint,
  WebsiteProject,
  WebsiteProjectFile,
  ProjectPage,
  SectionItem,
} from "@/lib/website-project";
import {
  renderStyles,
  renderScript,
  renderPageDocument,
} from "@/lib/website-render";

const MAX_PAGES = 6;
const MAX_SECTIONS_PER_PAGE = 10;
const MAX_ITEMS = 10;
const MAX_FIELD_LENGTH = 400;
const MAX_ARRAY_ITEM_LENGTH = 160;

const VALID_KINDS = new Set([
  "services",
  "about",
  "info",
  "features",
  "cta",
]);
const VALID_PATHS = new Set(["/", "/services", "/contact"]);

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseString(value: unknown, limit = MAX_FIELD_LENGTH): string {
  return typeof value === "string"
    ? value.trim().slice(0, limit)
    : "";
}

function parseOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_FIELD_LENGTH) : null;
}

/** External links rendered on the site must use http/https only. */
function parseExternalUrl(value: unknown): string | null {
  const raw = parseOptionalString(value);
  if (!raw) return null;
  let candidate = raw;
  if (candidate.startsWith("//")) candidate = "https:" + candidate;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function parseArray(value: unknown, limit = MAX_ITEMS): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().slice(0, MAX_ARRAY_ITEM_LENGTH);
    if (trimmed) result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

function parseSectionItems(value: unknown): SectionItem[] {
  if (!Array.isArray(value)) return [];
  const result: SectionItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = parseString(o.title, 80);
    const body = parseString(o.body, MAX_FIELD_LENGTH);
    if (title && body) {
      result.push({ title, body });
      if (result.length >= MAX_ITEMS) break;
    }
  }
  return result;
}

function isValidHex(color: unknown): boolean {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color);
}

function sanitizeColor(color: unknown, fallback: string): string {
  return isValidHex(color) ? (color as string).toLowerCase() : fallback;
}

export function parseBlueprint(value: unknown): WebsiteBlueprint | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;

  const tagline = parseString(v.tagline);
  const overview = parseString(v.overview);
  const targetAudience = parseString(v.targetAudience);
  const locationLabel = parseString(v.locationLabel);
  if (!tagline || !overview || !targetAudience || !locationLabel) return null;

  const primaryCtaObj = v.primaryCta as Record<string, unknown> | undefined;
  const primaryCta = {
    label: parseString(primaryCtaObj?.label, 50) || "Contact us",
    subtext: parseString(primaryCtaObj?.subtext, MAX_FIELD_LENGTH),
  };

  const ds = v.designSystem as Record<string, unknown> | undefined;
  if (!ds || typeof ds !== "object") return null;
  const pal = ds.palette as Record<string, unknown> | undefined;
  if (!pal || typeof pal !== "object") return null;
  const typo = ds.typography as Record<string, unknown> | undefined;
  if (!typo || typeof typo !== "object") return null;

  const designSystem = {
    palette: {
      primary: sanitizeColor(pal.primary, "#2563eb"),
      accent: sanitizeColor(pal.accent, "#16a34a"),
      background: sanitizeColor(pal.background, "#ffffff"),
      surface: sanitizeColor(pal.surface, "#f8fafc"),
      text: sanitizeColor(pal.text, "#0f172a"),
      muted: sanitizeColor(pal.muted, "#64748b"),
    },
    typography: {
      headingFont: parseString(typo.headingFont, 80) || "Inter",
      bodyFont: parseString(typo.bodyFont, 80) || "Inter",
      style: parseString(typo.style, MAX_FIELD_LENGTH),
    },
    spacing: parseString(ds.spacing, MAX_FIELD_LENGTH),
    layout: parseString(ds.layout, MAX_FIELD_LENGTH),
    aesthetic: parseString(ds.aesthetic, MAX_FIELD_LENGTH),
    rationale: parseString(ds.rationale, MAX_FIELD_LENGTH),
  };

  if (!Array.isArray(v.pages) || v.pages.length === 0) return null;

  const pages: ProjectPage[] = [];
  for (let i = 0; i < v.pages.length; i++) {
    const raw = v.pages[i] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") continue;

    const rawPath = parseString(raw.path) || "/";
    const slugPart = rawPath.replace(/^\//, "");
    const normalizedPath = VALID_PATHS.has(rawPath)
      ? rawPath
      : `/${slugPart ? slugify(slugPart) : `page-${i}`}`;
    const defaultNav =
      normalizedPath === "/"
        ? "Home"
        : (normalizedPath.replace("/", "").charAt(0).toUpperCase() +
            normalizedPath.replace("/", "").slice(1));
    const navLabel = parseString(raw.navLabel, 30) || defaultNav;
    const title = parseString(raw.title, 80);
    const description = parseString(raw.description, 200);
    if (!title) continue;

    const heroObj = raw.hero as Record<string, unknown> | undefined;
    const hero = {
      eyebrow: parseString(heroObj?.eyebrow, 80),
      heading: parseString(heroObj?.heading, 100),
      subheading: parseString(heroObj?.subheading, 200),
    };

    const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
    const sections: ProjectPage["sections"] = [];
    for (const s of rawSections) {
      if (!s || typeof s !== "object") continue;
      const sec = s as Record<string, unknown>;
      const kind = parseString(sec.kind, 20);
      if (!VALID_KINDS.has(kind)) continue;
      const heading = parseString(sec.heading, 80);
      const body = parseString(sec.body, MAX_FIELD_LENGTH);
      if (!heading || !body) continue;
      sections.push({
        kind: kind as ProjectPage["sections"][number]["kind"],
        heading,
        body,
        items: parseSectionItems(sec.items),
      });
      if (sections.length >= MAX_SECTIONS_PER_PAGE) break;
    }

    pages.push({
      path: normalizedPath,
      navLabel,
      title,
      description,
      hero,
      sections,
      hasContactSection: raw.hasContactSection === true,
    });
    if (pages.length >= MAX_PAGES) break;
  }
  if (pages.length === 0) return null;

  const contactObj = v.contact as Record<string, unknown> | undefined;

  return {
    tagline,
    overview,
    targetAudience,
    locationLabel,
    services: parseSectionItems(v.services),
    primaryCta,
    designSystem,
    pages,
    contact: {
      email: parseOptionalString(contactObj?.email),
      phone: parseOptionalString(contactObj?.phone),
      address: parseOptionalString(contactObj?.address),
      mapsUrl: parseExternalUrl(contactObj?.mapsUrl),
      websiteUrl: parseExternalUrl(contactObj?.websiteUrl),
    },
    footerNote: parseString(v.footerNote, MAX_FIELD_LENGTH),
    sourceFacts: parseArray(v.sourceFacts, 20),
    unknowns: parseArray(v.unknowns, 20),
    placeholders: Array.isArray(v.placeholders)
      ? (v.placeholders as Array<Record<string, unknown>>)
          .slice(0, 15)
          .map((ph) => ({
            field: parseString(ph.field, 80),
            replacement: parseString(ph.replacement, MAX_FIELD_LENGTH),
          }))
          .filter((ph) => ph.field)
      : [],
  };
}

export function normalizeBlueprint(blueprint: WebsiteBlueprint): WebsiteBlueprint {
  const hasHome = blueprint.pages.some((p) => p.path === "/");
  if (!hasHome) {
    blueprint.pages.unshift({
      path: "/",
      navLabel: "Home",
      title: `${blueprint.locationLabel} — ${blueprint.primaryCta.label}`,
      description: blueprint.overview,
      hero: {
        eyebrow: blueprint.locationLabel,
        heading: blueprint.tagline,
        subheading: blueprint.targetAudience,
      },
      sections: [],
      hasContactSection: false,
    });
  }

  const hasContactPage = blueprint.pages.some((p) => p.path === "/contact");
  if (!hasContactPage && (blueprint.contact.email || blueprint.contact.phone)) {
    blueprint.pages.push({
      path: "/contact",
      navLabel: "Contact",
      title: `Contact ${blueprint.locationLabel}`,
      description: "Get in touch.",
      hero: {
        eyebrow: "Contact",
        heading: blueprint.primaryCta.label,
        subheading: blueprint.primaryCta.subtext,
      },
      sections: [],
      hasContactSection: true,
    });
  }

  const home = blueprint.pages.find((p) => p.path === "/");

  if (home && blueprint.services.length > 0) {
    const hasServicesSection = home.sections.some((s) => s.kind === "services");
    if (!hasServicesSection) {
      home.sections.unshift({
        kind: "services",
        heading: "Our services",
        body: "",
        items: blueprint.services.map((s) => ({
          title: s.title,
          body: s.body,
        })),
      });
    }
  }

  if (home) {
    const hasAbout = home.sections.some((s) => s.kind === "about");
    if (!hasAbout) {
      home.sections.push({
        kind: "about",
        heading: `About ${blueprint.locationLabel}`,
        body: blueprint.overview,
      });
    }
  }

  if (home && !home.hasContactSection && (blueprint.contact.email || blueprint.contact.phone)) {
    home.hasContactSection = true;
  }

  if (home) {
    home.sections = home.sections.slice(0, MAX_SECTIONS_PER_PAGE);
  }

  return blueprint;
}

export function buildProject(
  projectId: string,
  businessName: string,
  slug: string,
  blueprint: WebsiteBlueprint,
): WebsiteProject {
  const contactPageExists = blueprint.pages.some((p) => p.path === "/contact");
  const primaryCta = {
    label: blueprint.primaryCta.label,
    subtext: blueprint.primaryCta.subtext,
    targetPage: contactPageExists ? "/contact" : "/",
  };

  const generatedCopy: WebsiteProject["generatedCopy"] = [
    { key: "tagline", text: blueprint.tagline },
    { key: "overview", text: blueprint.overview },
  ];
  for (const page of blueprint.pages) {
    generatedCopy.push({
      key: `${page.path}.hero.heading`,
      text: page.hero.heading,
    });
    generatedCopy.push({
      key: `${page.path}.hero.subheading`,
      text: page.hero.subheading,
    });
    for (const sec of page.sections) {
      generatedCopy.push({
        key: `${page.path}.${sec.kind}.${sec.heading}`,
        text: sec.body,
      });
    }
  }

  const resolveHref = (path: string) =>
    path === "/" ? "/index.html" : `${path}.html`;

  const partialProject: WebsiteProject = {
    projectId,
    businessName,
    slug,
    status: "completed",
    generatedAt: new Date().toISOString(),
    pages: blueprint.pages,
    files: [],
    generatedCopy,
    designDirection: blueprint.designSystem,
    primaryCta,
    contact: blueprint.contact,
    footerNote: blueprint.footerNote,
    sourceFacts: blueprint.sourceFacts,
    unknowns: blueprint.unknowns,
    placeholders: blueprint.placeholders,
  };

  const files: WebsiteProjectFile[] = [
    {
      path: "styles.css",
      contentType: "text/css",
      content: renderStyles(partialProject),
    },
    {
      path: "script.js",
      contentType: "text/javascript",
      content: renderScript(),
    },
  ];

  for (const page of blueprint.pages) {
    const fileName =
      page.path === "/" ? "index.html" : page.path.replace(/^\//, "") + ".html";
    files.push({
      path: fileName,
      contentType: "text/html",
      content: renderPageDocument(partialProject, page.path, {
        resolveHref,
        inlineCss: false,
      }),
    });
  }

  partialProject.files = files;
  return partialProject;
}

function buildPrompt(
  lead: QualifiedLead,
  contact: ContactDiscovery | null,
  research: WebsiteResearch,
): string {
  const evidence = {
    businessName: lead.businessName,
    address: lead.address,
    rating: lead.rating,
    reviewCount: lead.reviewCount,
    primaryType: lead.primaryType,
    types: lead.types,
    phone:
      lead.internationalPhoneNumber ??
      lead.nationalPhoneNumber ??
      null,
    contactEmail: contact?.email ?? null,
    contactPhone: contact?.phone ?? null,
    research,
  };

  return [
    "You are a senior web designer and copywriter. Create a website blueprint for a small professional business.",
    "",
    "STRICT RULES — never break these:",
    "1. Never invent business facts. No awards, years in business, client names, testimonials, certifications, pricing, hours, specific addresses/phones/emails beyond the evidence, social profiles, or performance claims.",
    "2. All copy must come strictly from the evidence. When evidence lacks a fact, omit it or record it in unknowns.",
    "3. Every service in services[] must correspond to evidence. Do not add fabricated services.",
    "4. contact fields must exactly match evidence; leave null if unknown.",
    "5. placeholders[] must record any neutral placeholder text used because a real value is missing.",
    "6. Allowed page paths: /, /services, /contact. Do not add /blog, /pricing, /portfolio, /gallery.",
    "7. Allowed section kinds: services, about, info, features, cta. Do not use testimonials, faq, pricing, or gallery.",
    "8. Design system: choose a tasteful, appropriate aesthetic. Provide a 6-color accessible palette (#hex), real font families, spacing/layout notes, and a rationale. Ensure high contrast.",
    "9. Keep headings concise (<=8 words). Service bodies: 1–2 sentences.",
    "10. Home page must include a services section (if services exist), about or CTA section, and a footerNote.",
    "",
    "EVIDENCE:",
    JSON.stringify(evidence, null, 2),
  ].join("\n");
}

const websiteSchema = {
  type: "object",
  properties: {
    tagline: { type: "string" },
    overview: { type: "string" },
    targetAudience: { type: "string" },
    locationLabel: { type: "string" },
    services: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["title", "body"],
      },
    },
    primaryCta: {
      type: "object",
      properties: {
        label: { type: "string" },
        subtext: { type: "string" },
      },
      required: ["label", "subtext"],
    },
    designSystem: {
      type: "object",
      properties: {
        palette: {
          type: "object",
          properties: {
            primary: { type: "string" },
            accent: { type: "string" },
            background: { type: "string" },
            surface: { type: "string" },
            text: { type: "string" },
            muted: { type: "string" },
          },
          required: [
            "primary",
            "accent",
            "background",
            "surface",
            "text",
            "muted",
          ],
        },
        typography: {
          type: "object",
          properties: {
            headingFont: { type: "string" },
            bodyFont: { type: "string" },
            style: { type: "string" },
          },
          required: ["headingFont", "bodyFont", "style"],
        },
        spacing: { type: "string" },
        layout: { type: "string" },
        aesthetic: { type: "string" },
        rationale: { type: "string" },
      },
      required: [
        "palette",
        "typography",
        "spacing",
        "layout",
        "aesthetic",
        "rationale",
      ],
    },
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          navLabel: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          hero: {
            type: "object",
            properties: {
              eyebrow: { type: "string" },
              heading: { type: "string" },
              subheading: { type: "string" },
            },
            required: ["eyebrow", "heading", "subheading"],
          },
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: ["services", "about", "info", "features", "cta"],
                },
                heading: { type: "string" },
                body: { type: "string" },
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      body: { type: "string" },
                    },
                    required: ["title", "body"],
                  },
                },
              },
              required: ["kind", "heading", "body"],
            },
          },
          hasContactSection: { type: "boolean" },
        },
        required: [
          "path",
          "navLabel",
          "title",
          "description",
          "hero",
          "sections",
          "hasContactSection",
        ],
      },
    },
    contact: {
      type: "object",
      properties: {
        email: { type: "string" },
        phone: { type: "string" },
        address: { type: "string" },
        mapsUrl: { type: "string" },
        websiteUrl: { type: "string" },
      },
    },
    footerNote: { type: "string" },
    sourceFacts: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "string" } },
    placeholders: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          replacement: { type: "string" },
        },
        required: ["field", "replacement"],
      },
    },
  },
  required: [
    "tagline",
    "overview",
    "targetAudience",
    "locationLabel",
    "services",
    "primaryCta",
    "designSystem",
    "pages",
    "contact",
    "sourceFacts",
    "unknowns",
    "placeholders",
  ],
};

export interface WebsiteGenerationResult {
  status: "completed" | "failed";
  project: WebsiteProject | null;
  errorMessage: string | null;
}

export async function generateWebsite({
  lead,
  contact,
  research,
}: {
  lead: QualifiedLead;
  contact: ContactDiscovery | null;
  research: WebsiteResearch;
}): Promise<WebsiteGenerationResult> {
  try {
    const prompt = buildPrompt(lead, contact, research);
    const blueprintRaw = await callGemini(prompt, websiteSchema, {
      temperature: 0.5,
    });
    let blueprint = parseBlueprint(blueprintRaw);
    if (!blueprint) {
      throw new Error("Gemini returned an incomplete blueprint.");
    }
    blueprint = normalizeBlueprint(blueprint);

    const businessName = lead.businessName;
    const slug = slugify(businessName) || "site";
    const projectId = `site_${slug}_${Date.now().toString(36)}`;
    const project = buildProject(projectId, businessName, slug, blueprint);

    return { status: "completed", project, errorMessage: null };
  } catch (error) {
    console.error("[website-builder] generation failed:", error);
    return {
      status: "failed",
      project: null,
      errorMessage: "Website generation is temporarily unavailable.",
    };
  }
}