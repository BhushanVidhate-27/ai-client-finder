import type { QualifiedLead } from "@/lib/lead-qualification";
import { JobStoppedError } from "@/lib/jobs/controller";
import { assertSafeFetchUrl } from "@/lib/url-safety";

export type ContactEmailType = "business" | "professional" | "unknown";
export type ContactConfidence = "high" | "medium" | "low";

export interface ContactDiscovery {
  email: string | null;
  emailType: ContactEmailType | null;
  emailSourceUrl: string | null;
  emailConfidence: ContactConfidence | null;
  emailStatus: "found" | "not_found" | "needs_review";
  phone: string | null;
  phoneSourceUrl: string | null;
  contactMethod: "email" | "phone" | "none";
  discoveryPath: "website" | "no_website";
}

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+\.[a-zA-Z]{2,}/g;
const MAILTO_PATTERN = /href\s*=\s*["']?mailto:([^"'<>\s?]+)/gi;
const ANCHOR_PATTERN = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;

const REQUEST_TIMEOUT_MS = 8000;
const MAX_PAGE_SIZE_BYTES = 2_000_000;
const MAX_ADDITIONAL_PAGES = 3;
const MAX_REDIRECTS = 5;
const CONCURRENCY = 3;

const CONTACT_PATH_PATTERN =
  /(contact|about|team|support|enquir|inquir|reach|info|get-in-touch)/i;

const BUSINESS_LOCAL_PARTS = new Set([
  "hello", "info", "contact", "studio", "bookings", "office", "sales",
  "support", "admin", "team", "media", "press", "marketing", "partners",
  "reception", "enquiries", "inquiries", "enquiry", "inquiry", "reservations",
  "service", "services", "mail", "care", "help", "feedback", "customerservice",
]);

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com",
  "hotmail.co.uk", "outlook.com", "outlook.es", "aol.com", "icloud.com",
  "me.com", "mac.com", "protonmail.com", "proton.me", "gmx.com", "gmx.de",
]);

const PLACEHOLDER_DOMAINS = /(^|\.)(example|example\.com|yourdomain|mydomain|realdomain|sentry|wixpress|email\.com|test)(\.|$)/i;
const FILE_LIKE_TLDS = /\.(png|jpe?g|gif|webp|svg|css|js|json|xml|map|woff2?|pdf|zip)(\.|$)/i;

const HIGH_SCORE = 60;
const MEDIUM_SCORE = 35;

interface FetchedPage {
  html: string;
  url: string;
}

interface EmailCandidate {
  email: string;
  emailType: ContactEmailType;
  score: number;
  sourceUrl: string;
}

const robotsCache = new Map<string, string>();

function notFoundResult(lead: QualifiedLead): ContactDiscovery {
  const phone = lead.internationalPhoneNumber ?? lead.nationalPhoneNumber ?? null;
  return {
    email: null,
    emailType: null,
    emailSourceUrl: null,
    emailConfidence: null,
    emailStatus: "not_found",
    phone,
    phoneSourceUrl: phone ? lead.googleMapsUrl : null,
    contactMethod: phone ? "phone" : "none",
    discoveryPath: lead.websiteUrl ? "website" : "no_website",
  };
}

function emptyResult(lead: QualifiedLead): ContactDiscovery {
  return {
    email: null,
    emailType: null,
    emailSourceUrl: null,
    emailConfidence: null,
    emailStatus: "not_found",
    phone: null,
    phoneSourceUrl: null,
    contactMethod: "none",
    discoveryPath: lead.websiteUrl ? "website" : "no_website",
  };
}

function isValidEmailAddress(email: string): boolean {
  const atIndex = email.lastIndexOf("@");
  if (atIndex <= 0) return false;

  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  if (!/^[a-zA-Z0-9._%+-]+$/.test(localPart)) return false;
  if (!/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(domain)) return false;
  if (email.length > 120 || localPart.length > 64) return false;
  if (localPart.includes("..") || domain.length > 253) return false;
  if (domain.endsWith(".")) return false;
  if (PLACEHOLDER_DOMAINS.test(email.toLowerCase())) return false;
  if (FILE_LIKE_TLDS.test(domain)) return false;

  return true;
}

function classifyEmailType(email: string): ContactEmailType {
  const localPart = email.split("@")[0].toLowerCase();
  const firstSegment = localPart.split(".")[0];

  if (BUSINESS_LOCAL_PARTS.has(localPart) || BUSINESS_LOCAL_PARTS.has(firstSegment)) {
    return "business";
  }

  if (localPart.includes(".") || /\d/.test(localPart)) {
    return "professional";
  }

  return "unknown";
}

function scoreEmail(
  email: string,
  emailType: ContactEmailType,
  viaMailto: boolean,
): number {
  let score = 0;

  if (emailType === "business") score += 40;
  else if (emailType === "professional") score += 20;
  else score += 12;

  if (viaMailto) score += 20;

  const domain = email.split("@")[1]?.toLowerCase();
  if (domain && FREE_MAIL_DOMAINS.has(domain)) score -= 10;

  return score;
}

interface FetchedResult {
  text: string;
  url: string;
  contentType: string;
}

async function fetchFromSite(rawUrl: string): Promise<FetchedResult | null> {
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    try {
      await assertSafeFetchUrl(currentUrl);
    } catch {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "AIClientFinderContactDiscovery/1.0",
          Accept: "text/html,application/xhtml+xml",
        },
        cache: "no-store",
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      try {
        currentUrl = new URL(location, currentUrl).href;
      } catch {
        return null;
      }
      continue;
    }

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_PAGE_SIZE_BYTES) return null;

    const text = await response.text();
    if (text.length > MAX_PAGE_SIZE_BYTES) return null;

    return { text, url: response.url || currentUrl, contentType };
  }

  return null;
}

function fetchUrl(url: string): Promise<FetchedResult | null> {
  // SSRF hardening happens inside fetchFromSite for every hop.
  return fetchFromSite(url);
}

async function fetchHtml(url: string): Promise<FetchedPage | null> {
  const result = await fetchUrl(url);
  if (!result) return null;
  if (!result.contentType.includes("text/html")) return null;
  return { html: result.text, url: result.url };
}

async function getRobotsText(origin: string): Promise<string> {
  if (robotsCache.has(origin)) return robotsCache.get(origin)!;

  let text = "";
  try {
    const result = await fetchUrl(new URL("/robots.txt", origin).href);
    if (result) text = result.text;
  } catch {
    text = "";
  }

  robotsCache.set(origin, text);
  return text;
}

function isPathDisallowed(robotsText: string, path: string): boolean {
  const disallowRules: string[] = [];
  let inStarGroup = false;

  for (const rawLine of robotsText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (key === "user-agent") {
      inStarGroup = value === "*";
    } else if (key === "disallow" && inStarGroup) {
      disallowRules.push(value);
    }
  }

  if (disallowRules.some((rule) => rule === "")) return false;

  return disallowRules.some((rule) => rule && path.startsWith(rule));
}

async function fetchHtmlRespectingRobots(url: string): Promise<FetchedPage | null> {
  try {
    const parsed = new URL(url);
    const robotsText = await getRobotsText(parsed.origin);
    const path = parsed.pathname + parsed.search;
    if (isPathDisallowed(robotsText, path)) return null;
  } catch {
    return null;
  }

  return fetchHtml(url);
}

function extractEmails(html: string): Array<{ email: string; viaMailto: boolean }> {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  const found: Array<{ email: string; viaMailto: boolean }> = [];
  const seen = new Set<string>();

  for (const match of withoutScripts.matchAll(MAILTO_PATTERN)) {
    const raw = match[1];
    if (!raw) continue;
    const email = decodeURIComponent(raw).toLowerCase().trim();
    if (!isValidEmailAddress(email) || seen.has(email)) continue;
    seen.add(email);
    found.push({ email, viaMailto: true });
  }

  for (const match of withoutScripts.matchAll(EMAIL_PATTERN)) {
    const email = match[0].toLowerCase();
    if (!isValidEmailAddress(email) || seen.has(email)) continue;
    seen.add(email);
    found.push({ email, viaMailto: false });
  }

  return found;
}

function findCandidateLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();

  for (const match of html.matchAll(ANCHOR_PATTERN)) {
    const href = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!href || href.startsWith("javascript:") || href.startsWith("#") || href.startsWith("mailto:")) {
      continue;
    }

    let absolute: URL;
    try {
      absolute = new URL(href, baseUrl);
    } catch {
      continue;
    }

    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") continue;
    if (absolute.origin !== new URL(baseUrl).origin) continue;

    const path = absolute.pathname;
    if (!CONTACT_PATH_PATTERN.test(path)) continue;
    if (/[.#]\w+\.(png|jpe?g|gif|webp|svg|css|js|pdf|zip)$/i.test(path)) continue;

    links.add(absolute.href);
  }

  const ranked = [...links];
  ranked.sort((a, b) => {
    const score = (href: string) =>
      href.includes("contact") ? 0 : href.includes("about") ? 1 : href.includes("team") ? 2 : 3;
    return score(a) - score(b);
  });

  return ranked.slice(0, MAX_ADDITIONAL_PAGES);
}

function buildResult(
  lead: QualifiedLead,
  email: string | null,
  emailType: ContactEmailType | null,
  emailSourceUrl: string | null,
  emailConfidence: ContactConfidence | null,
  emailStatus: "found" | "not_found" | "needs_review",
  discoveryPath: "website" | "no_website",
): ContactDiscovery {
  const phone = lead.internationalPhoneNumber ?? lead.nationalPhoneNumber ?? null;
  return {
    email,
    emailType,
    emailSourceUrl,
    emailConfidence,
    emailStatus,
    phone,
    phoneSourceUrl: phone ? lead.googleMapsUrl : null,
    contactMethod: email ? "email" : phone ? "phone" : "none",
    discoveryPath,
  };
}

export async function discoverLeadContact(lead: QualifiedLead): Promise<ContactDiscovery> {
  if (lead.websiteUrl) {
    return discoverFromWebsite(lead);
  }
  return discoverFromNoWebsite(lead);
}

async function discoverFromWebsite(lead: QualifiedLead): Promise<ContactDiscovery> {
  if (!lead.websiteUrl) return emptyResult(lead);

  let homepage: FetchedPage;
  try {
    const fetched = await fetchHtmlRespectingRobots(new URL(lead.websiteUrl).href);
    if (!fetched) return notFoundResult(lead);
    homepage = fetched;
  } catch {
    return notFoundResult(lead);
  }

  const pagesToCheck: FetchedPage[] = [homepage];

  for (const candidate of findCandidateLinks(homepage.html, homepage.url)) {
    const page = await fetchHtmlRespectingRobots(candidate);
    if (page) pagesToCheck.push(page);
  }

  const candidates: EmailCandidate[] = [];

  for (const page of pagesToCheck) {
    for (const { email, viaMailto } of extractEmails(page.html)) {
      const emailType = classifyEmailType(email);
      candidates.push({
        email,
        emailType,
        score: scoreEmail(email, emailType, viaMailto),
        sourceUrl: page.url,
      });
    }
  }

  if (candidates.length === 0) return notFoundResult(lead);

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  const emailConfidence: ContactConfidence =
    best.score >= HIGH_SCORE ? "high" : best.score >= MEDIUM_SCORE ? "medium" : "low";

  return buildResult(
    lead,
    best.email,
    best.emailType,
    best.sourceUrl,
    emailConfidence,
    emailConfidence === "low" ? "needs_review" : "found",
    "website",
  );
}

async function discoverFromNoWebsite(lead: QualifiedLead): Promise<ContactDiscovery> {
  return notFoundResult(lead);
}

export interface DiscoverHooks {
  beforeLead?: (lead: QualifiedLead, index: number) => Promise<void> | void;
  afterLead?: (
    lead: QualifiedLead,
    discovery: ContactDiscovery,
  ) => Promise<void> | void;
}

export async function discoverContacts(
  leads: QualifiedLead[],
  concurrency = CONCURRENCY,
  hooks?: DiscoverHooks,
): Promise<ContactDiscovery[]> {
  const results = new Array<ContactDiscovery>(leads.length);
  let nextIndex = 0;
  let stopped = false;

  const worker = async () => {
    while (!stopped && nextIndex < leads.length) {
      const index = nextIndex;
      nextIndex += 1;
      const lead = leads[index];
      try {
        await hooks?.beforeLead?.(lead, index);
        const discovery = await discoverLeadContact(lead);
        results[index] = discovery;
        await hooks?.afterLead?.(lead, discovery);
      } catch (error) {
        if (error instanceof JobStoppedError) {
          stopped = true;
        } else {
          results[index] = emptyResult(lead);
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