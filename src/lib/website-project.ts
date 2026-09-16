export type SectionKind =
  | "services"
  | "about"
  | "info"
  | "features"
  | "cta";

export interface SectionItem {
  title: string;
  body: string;
}

export interface PageSection {
  kind: SectionKind;
  heading: string;
  body: string;
  items?: SectionItem[];
}

export interface ProjectPage {
  path: string;
  navLabel: string;
  title: string;
  description: string;
  hero: {
    eyebrow: string;
    heading: string;
    subheading: string;
  };
  sections: PageSection[];
  hasContactSection: boolean;
}

export interface DesignSystem {
  palette: {
    primary: string;
    accent: string;
    background: string;
    surface: string;
    text: string;
    muted: string;
  };
  typography: {
    headingFont: string;
    bodyFont: string;
    style: string;
  };
  spacing: string;
  layout: string;
  aesthetic: string;
  rationale: string;
}

export interface ProjectContact {
  email: string | null;
  phone: string | null;
  address: string | null;
  mapsUrl: string | null;
  websiteUrl: string | null;
}

export interface WebsiteBlueprint {
  tagline: string;
  overview: string;
  targetAudience: string;
  locationLabel: string;
  services: SectionItem[];
  primaryCta: { label: string; subtext: string };
  designSystem: DesignSystem;
  pages: ProjectPage[];
  contact: ProjectContact;
  footerNote: string;
  sourceFacts: string[];
  unknowns: string[];
  placeholders: Array<{ field: string; replacement: string }>;
}

export interface WebsiteProjectFile {
  path: string;
  contentType: string;
  content: string;
}

export interface WebsiteProject {
  projectId: string;
  businessName: string;
  slug: string;
  status: "completed";
  generatedAt: string;
  pages: ProjectPage[];
  files: WebsiteProjectFile[];
  generatedCopy: Array<{ key: string; text: string }>;
  designDirection: DesignSystem;
  primaryCta: { label: string; subtext: string; targetPage: string };
  contact: ProjectContact;
  footerNote: string;
  sourceFacts: string[];
  unknowns: string[];
  placeholders: Array<{ field: string; replacement: string }>;
}