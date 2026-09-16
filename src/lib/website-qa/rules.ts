import type {
  QaAudit,
  QaAuditInput,
  QaCheck,
  QaIssue,
  QaReferences,
  QaResult,
  QaSeverity,
} from "./types";
import type { WorkspaceFileWithContent } from "@/lib/website-coding/workspace";
import type { BuildFinding } from "@/lib/website-coding/build";

// ---------------------------------------------------------------------------
// Small deterministic HTML/tag helpers (no browser, no DOM dependency).
// ---------------------------------------------------------------------------

export function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Strip tags, decode entities, collapse whitespace -> plain text. */
export function textContent(html: string): string {
  return unescapeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<\s*\/?\s*(?:address|article|aside|blockquote|br|div|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|section|table|tbody|td|th|thead|tr|ul)\b[^>]*>/gi,
        "\n ",
      )
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .trim();
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Decode attribute strings from a `<tag ...>` opening fragment. */
function parseAttrs(fragment: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

export interface HtmlElement {
  tag: string;
  attrs: Record<string, string>;
  html: string;
}

/** Non-nested capture of `<tag attrs>body</tag>` blocks (flat, generated HTML). */
function captureElements(html: string, tag: string): HtmlElement[] {
  const out: HtmlElement[] = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({
      tag,
      attrs: parseAttrs(m[1] ?? ""),
      html: m[0],
    });
  }
  return out;
}

/** Void elements (`<img ...>`, `<input ...>`). */
function locateVoidTags(html: string, tag: string): HtmlElement[] {
  const out: HtmlElement[] = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)/?>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({
      tag,
      attrs: parseAttrs(m[1] ?? ""),
      html: m[0].trim(),
    });
  }
  return out;
}

export function elementTextOf(el: HtmlElement): string {
  return textContent(el.html);
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "our", "with", "from", "that", "this",
  "have", "your", "you", "we", "us", "at", "or", "as", "by", "on", "in",
  "to", "a", "an", "is", "it", "of", "be", "not", "has", "had", "they",
]);

export function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const set = new Set<string>();
  for (const w of words) {
    if (w.length > 2 && !STOPWORDS.has(w)) set.add(w);
  }
  return set;
}

function hasIntersection(a: Set<string>, b: Set<string>): boolean {
  for (const w of a) if (b.has(w)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Evidence collection
// ---------------------------------------------------------------------------

export interface QaEvidence {
  businessName: string | null;
  city: string | null;
  services: Set<string>;
  audience: string | null;
  emails: Set<string>;
  phoneDigits: Set<string>;
  addresses: string[];
  verifiedAddressNormalized: Set<string>;
  reviewCount: number | null;
  rating: number | null;
  businessStatus: string | null;
  websiteUrl: string | null;
  evidenceStrings: string[];
  evidenceWords: Set<string>;
  nicheTerms: string[];
  unknownWords: Set<string>;
}

function normalizeAddress(value: string): string {
  return unescapeHtml(value)
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const STREET_RE =
  /\d{1,5}\s+[a-z]+(?:\s+[a-z]+)?\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|way)(?:\.|,)?/i;

function extractCityFromAddress(address: string): string {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

export function collectEvidence(refs: QaReferences): QaEvidence {
  const lead = refs.lead ?? null;
  const research = refs.research ?? null;
  const contact = refs.contact ?? null;

  const verifiedFacts = [
    ...(refs.verifiedFacts ?? []),
    ...(research?.verifiedFacts ?? []),
  ];
  const unknowns = [...(refs.unknowns ?? []), ...(research?.unknowns ?? [])];

  const emails = new Set<string>();
  if (contact?.email) emails.add(contact.email.trim().toLowerCase());
  const foundEmails = verifiedFacts
    .map((f) => f.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0])
    .filter((e): e is string => Boolean(e))
    .map((e) => e.toLowerCase());
  for (const e of foundEmails) emails.add(e);

  const phoneDigits = new Set<string>();
  const phoneSources = [
    contact?.phone,
    lead?.internationalPhoneNumber,
    lead?.nationalPhoneNumber,
  ].filter((p): p is string => Boolean(p));
  for (const p of phoneSources) {
    const digits = p.replace(/[^\d]/g, "");
    if (digits.length >= 7) phoneDigits.add(digits);
  }

  const city =
    research?.location?.trim() ||
    (lead?.address ? extractCityFromAddress(lead.address) : "") ||
    null;

  const services = new Set<string>(
    (research?.services ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  const audience = research?.targetAudience?.trim().toLowerCase() || null;

  const addresses: string[] = [];
  if (lead?.address) addresses.push(lead.address);
  for (const f of verifiedFacts) {
    const m = f.match(STREET_RE);
    if (m && !addresses.includes(m[0])) addresses.push(m[0]);
  }

  const evidenceStrings = [
    lead?.businessName ?? "",
    research?.businessSummary ?? "",
    research?.targetAudience ?? "",
    research?.location ?? "",
    ...(research?.services ?? []),
    ...verifiedFacts,
    ...emails,
    ...phoneSources,
    ...addresses,
  ].filter((s) => s.length > 0);

  const evidenceWords = new Set<string>();
  for (const s of evidenceStrings) {
    for (const w of contentWords(s)) evidenceWords.add(w);
  }

  const rawNiche = (refs.targetNiche ?? "").trim();
  const nicheTerms = rawNiche
    .toLowerCase()
    .split(/[\s&,_-]+/)
    .filter((t) => t.length > 2);

  const unknownWords = new Set<string>();
  for (const unknown of unknowns) {
    const cleaned = unknown
      .toLowerCase()
      .replace(/\b(?:unknown|unverified|not\s+known|n\/a)\b|[?.]$/g, " ");
    const words = cleaned
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w));
    for (const w of words) unknownWords.add(w);
  }

  return {
    businessName: lead?.businessName?.trim() || null,
    city,
    services,
    audience,
    emails,
    phoneDigits,
    addresses,
    verifiedAddressNormalized: new Set(addresses.map(normalizeAddress)),
    reviewCount: lead?.reviewCount ?? null,
    rating: lead?.rating ?? null,
    businessStatus: lead?.businessStatus ?? null,
    websiteUrl: lead?.websiteUrl ?? null,
    evidenceStrings,
    evidenceWords,
    nicheTerms,
    unknownWords,
  };
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------

function htmlRoutes(files: WorkspaceFileWithContent[]): Set<string> {
  const routes = new Set<string>();
  for (const f of files) {
    if (f.path.endsWith(".html")) {
      routes.add(f.path);
      routes.add(`/${f.path}`);
      routes.add(`/${f.path.replace(/\.html$/, "")}`);
    }
  }
  routes.add("index.html");
  routes.add("/");
  routes.add("index");
  return routes;
}

export function resolveInternalRoute(
  href: string,
  routes: Set<string>,
): string | null {
  const raw = href.split(/[?#]/)[0];
  if (!raw) return null;
  if (raw === "/") return "index.html";
  const cleaned = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleaned) return null;

  // Extension-less links refer to a page of the same base name.
  let target = cleaned;
  if (!cleaned.endsWith(".html") && !cleaned.includes(".")) {
    target = cleaned + ".html";
  }
  if (routes.has(target) || routes.has("/" + target)) return target;

  // Allow an extension-less page link pointing at the matching page file.
  if (!cleaned.endsWith(".html") && routes.has(cleaned + ".html")) {
    return cleaned + ".html";
  }
  return null;
}

export function isBrokenInternalHref(
  href: string,
  routes: Set<string>,
): boolean {
  const trimmed = href.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("#")) return false;
  if (trimmed.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
  return resolveInternalRoute(trimmed, routes) === null;
}

/** The one unambiguous existing route a broken href could mean, or null. */
export function relinkCandidate(href: string, routes: Set<string>): string | null {
  return resolveInternalRoute(href, routes);
}

// ---------------------------------------------------------------------------
// Issue/check helpers
// ---------------------------------------------------------------------------

let issueCounter = 0;

function issue(
  category: QaIssue["category"],
  severity: QaSeverity,
  description: string,
  file: string | null,
  evidence: string,
  fixable: boolean,
  fixKind?: QaIssue["fixKind"],
  idHint: string = "issue",
): QaIssue {
  issueCounter += 1;
  return {
    id: `qa-${idHint}-${issueCounter}`,
    category,
    severity,
    description,
    file,
    evidence: evidence.slice(0, 500),
    fixable,
    fixKind,
  };
}

function check(
  id: string,
  name: string,
  category: QaIssue["category"],
  passed: boolean,
  detail?: string,
): QaCheck {
  return { id, name, category, passed, detail };
}

// ---------------------------------------------------------------------------
// Content QA
// ---------------------------------------------------------------------------

const LOREM_RE =
  /\blorem\s+ipsum\b|\b(?:todo|fixme)\b|\[(?:insert|placeholder|put)\b|\bxxxx?\b|\b(?:xxx|sample text|dummy text)\b/i;
const PLACEHOLDER_COPY_RE =
  /\b(?:coming soon|under construction|replace(?: me)? with|your ?(?:content|text|copy)? here|filler text)\b/i;

function checkContent(
  files: WorkspaceFileWithContent[],
  ev: QaEvidence,
  issues: QaIssue[],
  checks: QaCheck[],
): void {
  const allHtml = files
    .filter((f) => f.path.endsWith(".html"))
    .map((f) => f.content)
    .join("\n");
  const text = textContent(allHtml).toLowerCase();

  const lorem = text.match(LOREM_RE);
  checks.push(
    check(
      "qa-check-no-placeholders",
      "No lorem ipsum or placeholder copy",
      "content",
      !lorem,
      lorem ? `Found "${lorem[0]}"` : undefined,
    ),
  );
  if (lorem) {
    issues.push(
      issue("content", "high", "Lorem ipsum / placeholder text detected.", null,
        lorem[0], true, "remove-sentence", "placeholder"),
    );
  }

  const placeholder = text.match(PLACEHOLDER_COPY_RE);
  checks.push(
    check(
      "qa-check-no-boilerplate",
      "No coming-soon / boilerplate copy",
      "content",
      !placeholder,
      placeholder ? `Found "${placeholder[0]}"` : undefined,
    ),
  );
  if (placeholder) {
    issues.push(
      issue("content", "medium", "Boilerplate placeholder copy present.", null,
        placeholder[0], true, "remove-sentence", "boilerplate"),
    );
  }

  checkTestimonials(files, ev, issues, checks);
  checkReviews(files, ev, issues, checks, text);
  checkFabricatedServices(files, ev, issues, checks);
  checkYearsExperience(files, ev, issues, checks, text);
  checkPricing(files, ev, issues, checks);
  checkAwards(files, ev, issues, checks);
}

/** Any testimonial / review quote must exist in verified evidence. */
function checkTestimonials(
  files: WorkspaceFileWithContent[],
  ev: QaEvidence,
  issues: QaIssue[],
  checks: QaCheck[],
): void {
  const evidenceText = ev.evidenceStrings.join(" ").toLowerCase();
  let found = false;
  for (const f of files) {
    if (!f.path.endsWith(".html")) continue;
    const quotes = captureElements(f.content, "blockquote");
    for (const quote of quotes) {
      const body = elementTextOf(quote)
        .replace(/^(?:“[”"\s]+|["“”\s]+)/, "")
        .replace(/["“”\s]+$/, "")
        .trim();
      const supported = body.length > 0 && evidenceText.includes(body.toLowerCase());
      if (!supported) {
        found = true;
        issues.push(
          issue("content", "high",
            "Testimonial quote is not present in the verified evidence.",
            f.path, body || quote.html, true, "remove-testimonial", "testimonial"),
        );
      }
    }
    const cls = f.content.match(/class="[^"]*\btestimonial\b/i);
    if (cls) {
      found = true;
      issues.push(issue("content", "high",
        "Testimonial markup has no supporting evidence.",
        f.path, cls[0], true, "remove-testimonial", "testimonial"));
    }
  }
  checks.push(check("qa-check-no-unsourced-testimonials",
    "No unsourced testimonials or reviews", "content", !found,
    found ? "testimonial content without verified evidence" : undefined));
}

function checkReviews(
  files: WorkspaceFileWithContent[],
  ev: QaEvidence,
  issues: QaIssue[],
  checks: QaCheck[],
  text: string,
): void {
  const reviewMatch = text.match(/\b(\d{1,3})\s+reviews?\b/i);
  const ratingMatch = text.match(/\brated\s+(\d(?:\.\d)?)\s*(?:out of 5|stars?)\b/i);
  const claimed = reviewMatch ? Number(reviewMatch[1]) : null;
  const claimedRating = ratingMatch ? Number(ratingMatch[1]) : null;

  const evidenceHasClaims = /\b\d+\s+reviews?\b|\brated\s+/i.test(
    ev.evidenceStrings.join(" "),
  );

  const badCount =
    claimed != null && (ev.reviewCount === null || claimed > ev.reviewCount);
  const badRating =
    claimedRating != null && (ev.rating === null || claimedRating > ev.rating);

  checks.push(check("qa-check-no-fabricated-reviews",
    "No fabricated review counts / ratings", "content",
    (!badCount && !badRating) || evidenceHasClaims,
    !badCount && !badRating ? undefined : "a review count or rating not supported by evidence was claimed"));

  if (badCount) {
    issues.push(issue("content", "high",
      `Claims ${claimed} reviews while the verified count is ${ev.reviewCount ?? "unknown"}.`,
      null, `"${reviewMatch![0]}"`, true, "remove-sentence", "reviews"));
  }
  if (badRating) {
    issues.push(issue("content", "high",
      `Claims a rating of ${claimedRating} with no verified support.`,
      null, `"${ratingMatch![0]}"`, true, "remove-sentence", "rating"));
  }
}

/** Every service highlighted by the site must be a verified service. */
function checkFabricatedServices(
  files: WorkspaceFileWithContent[],
  ev: QaEvidence,
  issues: QaIssue[],
  checks: QaCheck[],
): void {
  let anyFake = false;
  for (const f of files) {
    if (!f.path.endsWith(".html")) continue;
    const titleMatches = [
      ...f.content.matchAll(/<article class="card">[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi),
      ...f.content.matchAll(/<li class="feature-list__item">[\s\S]*?<h4[^>]*>([\s\S]*?)<\/h4>/gi),
    ];
    for (const m of titleMatches) {
      const title = textContent(m[1] ?? "").trim();
      if (title && !ev.services.has(title.toLowerCase())) {
        anyFake = true;
        issues.push(issue("business-safety", "high",
          `Service "${title}" is presented as offered but is not a verified service.`,
          f.path, title, true, "remove-service-card", "fabricated-service"));
      }
    }
  }
  checks.push(check("qa-check-no-fabricated-services",
    "No unverified services presented", "business-safety", !anyFake,
    anyFake ? "a service with no verified support was listed" : undefined));
}

function checkYearsExperience(
  _files: WorkspaceFileWithContent[],
  ev: QaEvidence,
  issues: QaIssue[],
  checks: QaCheck[],
  text: string,
): void {
  const claim =
    text.match(/\b(?:over\s+)?\d{1,2}\s+years?(?:\s+of)?\s+(?:experience|in business|serving|providing)/i) ||
    text.match(/\b(?:since|established|founded|est\.?)\s+\d{4}\b/i);
  const evidenceHasYears = /\d+\s+years?|\bsince\s+\d{4}|\best\.?\s+\d{4}/i.test(
    ev.evidenceStrings.join(" "),
  );

  checks.push(check("qa-check-no-fabricated-years",
    "No unsupported years/experience claims", "business-safety",
    !claim || evidenceHasYears,
    claim && !evidenceHasYears ? "years/est. claim not supported by evidence" : undefined));

  if (claim && !evidenceHasYears) {
    issues.push(issue("business-safety", "high",
      "Claims years of experience / establishment date with no verified support.",
      null, `"${claim[0]}"`, true, "remove-sentence", "years"));
  }
}

function allPageText(files: WorkspaceFileWithContent[]): string {
  return files
    .filter((f) => f.path.endsWith(".html"))
    .map((f) => textContent(f.content))
    .join(" ");
}

function checkPricing(
  files: WorkspaceFileWithContent[],
  ev: QaEvidence,
  issues: QaIssue[],
  checks: QaCheck[],
): void {
  const text = allPageText(files);
  const claim =
    text.match(/starting at\s*\$?\s*\d[\d,.]*/i) ||
    text.match(/\$\s?\d[\d,.]*(?:\s*(?:per|\/)\s*(?:month|hour|hr|project|visit|session|year|mo))?/i);
  const evidenceHasPricing = /\$\s?\d|\bpricing\b|\bpackages?\b/i.test(
    ev.evidenceStrings.join(" "),
  );

  checks.push(check("qa-check-no-fabricated-pricing",
    "No unsupported pricing", "business-safety", !claim || evidenceHasPricing,
    claim && !evidenceHasPricing ? "pricing present without verified evidence" : undefined));

  if (claim && !evidenceHasPricing) {
    issues.push(issue("business-safety", "high",
      "Pricing claim with no verified support.", null,
      `"${claim[0]}"`, true, "remove-sentence", "pricing"));
  }
}

function checkAwards(
  files: WorkspaceFileWithContent[],
  ev: QaEvidence,
  issues: QaIssue[],
  checks: QaCheck[],
): void {
  const text = allPageText(files);
  const claim = text.match(
    /(?:award-winning|award of|voted|ranked|winner of|recognized as|best of)\b/i,
  );
  const evidenceHasAwards = /(?:award|ranked|winner|recognized)\b/i.test(
    ev.evidenceStrings.join(" "),
  );

  checks.push(check("qa-check-no-fabricated-awards",
    "No unsupported awards/rankings", "business-safety",
    !claim || evidenceHasAwards,
    claim && !evidenceHasAwards ? "an award/ranking claim lacks verified support" : undefined));

  if (claim && !evidenceHasAwards) {
    issues.push(issue("business-safety", "high",
      "Award/ranking claim with no verified support.", null,
      `"${claim[0]}"`, true, "remove-sentence", "awards"));
  }
}

// ---------------------------------------------------------------------------
// Contact QA
// ---------------------------------------------------------------------------

function checkContact(
  files: WorkspaceFileWithContent[],
  ev: QaEvidence,
  issues: QaIssue[],
  checks: QaCheck[],
): void {
  let emailsOk = true;
  let phonesOk = true;
  let addressesOk = true;

  for (const f of files) {
    if (!f.path.endsWith(".html")) continue;
    const html = f.content;

    const mailtoRe = /\bhref="mailto:([^"]+)"/gi;
    let m1: RegExpExecArray | null;
    while ((m1 = mailtoRe.exec(html)) !== null) {
      const email = m1[1].trim().toLowerCase();
      if (!ev.emails.has(email)) {
        emailsOk = false;
        issues.push(issue("contact", "critical",
          `Email ${email} appears on the site but is not backed by verified evidence.`,
          f.path, `mailto:${email}`, true, "remove-contact-item", "contact-email"));
      }
    }

    const telRe = /\bhref="tel:([^"]+)"/gi;
    let m2: RegExpExecArray | null;
    while ((m2 = telRe.exec(html)) !== null) {
      const digits = m2[1].replace(/[^\d]/g, "");
      const looksFake = /555|0000|12345/i.test(m2[1]);
      if (!ev.phoneDigits.has(digits)) {
        phonesOk = false;
        issues.push(issue("contact", "critical",
          `Phone ${m2[1]} appears on the site but is not a verified contact value.`,
          f.path, `tel:${m2[1]}`, true, "remove-contact-item",
          looksFake ? "contact-fake-phone" : "contact-phone"));
      }
    }

    const streetClaims = new Set<string>();
    const contactAreas = html.split(/id="contact"|class="[^"]*\bcontact\b/i).slice(1);
    for (const area of contactAreas) {
      const sm = area.match(STREET_RE);
      if (sm) streetClaims.add(normalizeAddress(sm[0]));
    }
    for (const claimed of streetClaims) {
      if (!ev.verifiedAddressNormalized.has(claimed)) {
        addressesOk = false;
        issues.push(issue("contact", "critical",
          `Address "${claimed}" in the contact section is not backed by verified evidence.`,
          f.path, claimed, true, "remove-contact-item", "contact-address"));
      }
    }
  }

  checks.push(check("qa-check-contacts-verified",
    "Rendered contact info is verified", "contact",
    emailsOk && phonesOk && addressesOk,
    emailsOk && phonesOk && addressesOk
      ? undefined
      : "an unverified contact value was rendered on the site"));
}

// ---------------------------------------------------------------------------
// Link / safety QA
// ---------------------------------------------------------------------------

function checkLinks(
  files: WorkspaceFileWithContent[],
  issues: QaIssue[],
  checks: QaCheck[],
): void {
  const routes = htmlRoutes(files);
  let unsafe = false;
  let traversal = false;

  for (const f of files) {
    if (!f.path.endsWith(".html")) continue;
    const html = f.content;

    const jsMatch = html.match(/\bhref\s*=\s*["']\s*javascript:/i);
    const dataMatch = html.match(/\bhref\s*=\s*["']\s*data:/i);
    const protoMatch = html.match(/\bhref\s*=\s*["']\s*\/\//i);
    const traversalMatch = html.match(/\bhref\s*=\s*["'][^"']*\.\.(?:\.|\/)/i);

    if (jsMatch) {
      unsafe = true;
      issues.push(issue("link", "critical",
        "javascript: URL is executable and unsafe.", f.path,
        jsMatch[0], true, "remove-element", "js-url"));
    }
    if (dataMatch) {
      unsafe = true;
      issues.push(issue("link", "critical",
        "data: URL is potentially unsafe.", f.path,
        dataMatch[0], true, "remove-element", "data-url"));
    }
    if (protoMatch) {
      unsafe = true;
      issues.push(issue("link", "critical",
        "Protocol-relative URL is unsafe.", f.path,
        protoMatch[0], true, "remove-element", "proto-url"));
    }
    if (traversalMatch) {
      traversal = true;
      issues.push(issue("link", "critical",
        "Path traversal in a link reference.", f.path,
        traversalMatch[0], true, "remove-element", "traversal"));
    }

    const hrefRe = /<a\b[^>]*>/gi;
    let h: RegExpExecArray | null;
    while ((h = hrefRe.exec(html)) !== null) {
      const hrefMatch = h[0].match(/\bhref\s*=\s*["']([^"']*)["']/i);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];
      if (isBrokenInternalHref(href, routes)) {
        const candidate = relinkCandidate(href, routes);
        issues.push(issue("structural", "high",
          `Internal link "${href}" does not resolve to an existing page.`,
          f.path, href, candidate !== null,
          candidate !== null ? "fix-internal-link" : undefined, "broken-link"));
      }
    }
  }

  checks.push(check("qa-check-no-unsafe-urls",
    "No executable / protocol-relative URLs", "link",
    !unsafe, unsafe ? "an unsafe executable or protocol-relative URL was found" : undefined));
  checks.push(check("qa-check-no-traversal",
    "No path traversal in references", "link",
    !traversal, traversal ? "a link attempts to escape the project structure" : undefined));
}

// ---------------------------------------------------------------------------
// Structural QA (content-only; enriched by the deterministic build validator)
// ---------------------------------------------------------------------------

function checkStructure(
  files: WorkspaceFileWithContent[],
  refs: QaReferences,
  build: QaAuditInput["build"],
  issues: QaIssue[],
  checks: QaCheck[],
): void {
  const required = refs.requiredFiles ?? ["index.html"];
  const present = new Set(files.map((f) => f.path));

  let missing = false;
  for (const req of required) {
    if (!present.has(req)) {
      missing = true;
      issues.push(issue("structural", "high",
        `Required file "${req}" is missing.`, req, req, false, undefined, "missing-file"));
    }
  }
  checks.push(check("qa-check-required-files", "Required files present", "structural",
    !missing, missing ? "one or more required files are missing" : undefined));

  let empty = false;
  for (const f of files) {
    if (f.path.endsWith(".html") && textContent(f.content).trim().length === 0) {
      empty = true;
      issues.push(issue("structural", "high",
        "Required page file is empty.", f.path, `${f.path} (0 words)`, false, undefined, "empty-file"));
    }
  }
  checks.push(check("qa-check-no-empty-files", "No empty required files", "structural",
    !empty, empty ? "an empty required file was found" : undefined));

  const homepage = files.find((f) => f.path === "index.html");
  const homepageOk = Boolean(homepage && textContent(homepage.content).trim().length > 0);
  checks.push(check("qa-check-homepage", "Homepage present and non-empty", "structural",
    homepageOk, homepageOk ? undefined : "index.html missing or empty"));

  if (build) {
    for (const finding of build.findings) {
      const fixableFor = (code: BuildFinding["code"]): { fixable: boolean; fixKind?: QaIssue["fixKind"] } => {
        switch (code) {
          case "broken-link":
          case "forbidden-content":
            return { fixable: true, fixKind: "fix-internal-link" };
          default:
            return { fixable: false };
        }
      };
      const f = fixableFor(finding.code);
      issues.push(issue("structural", "high", finding.message, finding.file,
        finding.message, f.fixable, f.fixKind, `build-${finding.code}`));
    }
    checks.push(check("qa-check-build-validator",
      "Deterministic build validation passes", "structural",
      build.status === "success",
      build.status === "success" ? undefined : "build validation reported errors"));
  } else {
    checks.push(check("qa-check-build-validator", "Build validation available", "structural", true));
  }
}

// ---------------------------------------------------------------------------
// Responsive / UI static QA
// ---------------------------------------------------------------------------

function checkResponsive(
  files: WorkspaceFileWithContent[],
  issues: QaIssue[],
  checks: QaCheck[],
): void {
  let fixedWidth = false;
  for (const f of files) {
    if (!/\.(css|html)$/.test(f.path)) continue;
    const m = f.content.match(/(?:^|[;{])\s*width\s*:\s*(\d{4,})px/i);
    if (m) {
      fixedWidth = true;
      issues.push(issue("responsive", "medium",
        "A fixed width of at least 1000px is set; it will not scale on small screens.",
        f.path, m[0].trim(), false, undefined, "fixed-width"));
    }
  }
  checks.push(check("qa-check-responsive-widths",
    "No fixed-width layouts likely to overflow", "responsive",
    !fixedWidth, fixedWidth ? "fixed width detected" : undefined));

  let navOk = true;
  for (const f of files) {
    if (!f.path.endsWith(".html")) continue;
    for (const nav of captureElements(f.content, "nav")) {
      const links = nav.html.match(/<a\b/i);
      if (!links) {
        navOk = false;
        issues.push(issue("accessibility", "medium",
          "Navigation element contains no links.", f.path, nav.html, false, undefined, "empty-nav"));
      }
    }
  }
  checks.push(check("qa-check-nav-content", "Navigation is not empty", "responsive", navOk));
}

// ---------------------------------------------------------------------------
// Accessibility static QA
// ---------------------------------------------------------------------------

function hasAccessibleName(el: HtmlElement): boolean {
  return Boolean(
    el.attrs["aria-label"]?.trim() || el.attrs["aria-labelledby"]?.trim(),
  );
}

/** True when some `<label for="id">` exists for this input's id. */
function hasLabelForId(id: string, html: string): boolean {
  const pattern = new RegExp(
    `<label\\b[^>]*for=["']${escapeRegex(id)}["']`,
    "i",
  );
  return pattern.test(html);
}

/** True when the input (matched at [start,end)) sits inside a <label>. */
function isWrappedInLabel(html: string, start: number, end: number): boolean {
  const before = html.slice(Math.max(0, start - 300), start);
  const labelIdx = before.lastIndexOf("<label");
  if (labelIdx < 0) return false;
  const closeIdx = html.indexOf("</label>", end);
  return closeIdx >= 0 && closeIdx > end;
}

function checkAccessibility(
  files: WorkspaceFileWithContent[],
  issues: QaIssue[],
  checks: QaCheck[],
): void {
  let imagesOk = true;
  let linksOk = true;
  let inputsOk = true;
  let headingsOk = true;

  for (const f of files) {
    if (!f.path.endsWith(".html")) continue;
    const html = f.content;

    for (const img of locateVoidTags(html, "img")) {
      if (!("alt" in img.attrs) && img.attrs["aria-hidden"] !== "true") {
        imagesOk = false;
        issues.push(issue("accessibility", "medium",
          "Image has no alt attribute; screen reader users get no description.",
          f.path, img.html, true, "add-alt", "missing-alt"));
      }
    }

    for (const a of captureElements(html, "a")) {
      const inner = elementTextOf(a);
      if (inner.trim().length === 0 && !hasAccessibleName(a)) {
        linksOk = false;
        issues.push(issue("accessibility", "medium",
          "Link has no usable text or accessible name.",
          f.path, a.html, false, undefined, "empty-link"));
      }
    }

    for (const button of captureElements(html, "button")) {
      const inner = elementTextOf(button);
      if (inner.trim().length === 0 && !hasAccessibleName(button)) {
        linksOk = false;
        issues.push(issue("accessibility", "medium",
          "Button has no usable label.",
          f.path, button.html, false, undefined, "empty-button"));
      }
    }

    for (const input of locateVoidTags(html, "input")) {
      const type = (input.attrs["type"] ?? "text").toLowerCase();
      if (type === "hidden") continue;
      const start = html.indexOf(input.html);
      const end = start + input.html.length;
      const id = input.attrs["id"];
      const named = Boolean(
        input.attrs["aria-label"]?.trim() ||
          input.attrs["aria-labelledby"]?.trim() ||
          (id ? hasLabelForId(id, html) : false) ||
          isWrappedInLabel(html, start, end),
      );
      if (!named) {
        inputsOk = false;
        issues.push(issue("accessibility", "medium",
          "Form input has no associated label or accessible name.",
          f.path, input.html, false, undefined, "unlabelled-input"));
      }
    }

    const headings = [
      ...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi),
    ].map((m) => ({ level: Number(m[1]), text: textContent(m[2] ?? "") }));
    const h1Count = headings.filter((h) => h.level === 1).length;
    if (h1Count !== 1) {
      headingsOk = false;
      issues.push(issue("accessibility", "medium",
        h1Count === 0 ? "Page has no <h1> main heading." : `Page has ${h1Count} <h1> elements.`,
        f.path,
        headings.slice(0, 3).map((h) => `h${h.level}: ${h.text}`).join(" | ") || f.path,
        false, undefined, "heading-structure"));
    }
  }

  checks.push(check("qa-check-images-alt", "Images have alt text", "accessibility", imagesOk));
  checks.push(check("qa-check-link-text", "Links and buttons have usable labels", "accessibility", linksOk));
  checks.push(check("qa-check-input-labels", "Form inputs have accessible labels", "accessibility", inputsOk));
  checks.push(check("qa-check-heading-structure", "Heading structure is sane (single h1)", "accessibility", headingsOk));

  const titlesOk = files
    .filter((f) => f.path.endsWith(".html"))
    .every((f) => {
      const m = f.content.match(/<title>([^<]*)<\/title>/i);
      return Boolean(m && m[1]?.trim());
    });
  checks.push(check("qa-check-page-titles", "Pages have non-empty titles", "accessibility", titlesOk));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkViewport(
  files: WorkspaceFileWithContent[],
  issues: QaIssue[],
  checks: QaCheck[],
): void {
  let ok = true;
  for (const f of files) {
    if (!f.path.endsWith(".html")) continue;
    if (!/name=["']viewport["']/i.test(f.content)) {
      ok = false;
      issues.push(issue("responsive", "medium",
        "Page is missing a viewport meta tag; it will not scale properly on mobile.",
        f.path, f.path, true, "add-viewport", "no-viewport"));
    }
  }
  checks.push(check("qa-check-viewport", "Responsive viewport configured", "responsive", ok));
}

// ---------------------------------------------------------------------------
// Business-safety QA
// ---------------------------------------------------------------------------

const CLAIM_RE =
  /\b(?:specializ\w*\s+in|expert\w*\s+in|dedicated to|focus(?:es|ed)?\s+on|we\s+(?:offer|provide|deliver|serve|are)\s+|our\s+(?:specialty|focus))\b/i;
const SUPERLATIVE_RE =
  /(?:'s|\u2019s)\s+leading|\bbest\s+(?:in|near|around|at|for|of)|\b(?:premier|top-rated|award-winning|voted|ranked|#1)\b/i;

function checkBusinessSafety(
  files: WorkspaceFileWithContent[],
  ev: QaEvidence,
  issues: QaIssue[],
  checks: QaCheck[],
): void {
  let claimsOk = true;

  for (const f of files) {
    if (!f.path.endsWith(".html")) continue;
    const text = textContent(f.content);
    const sentences = splitSentences(text);

    for (const sentence of sentences) {
      if (/^(home|services|contact|about)\b/i.test(sentence) && sentence.length < 12) continue;

      const claimed = CLAIM_RE.exec(sentence) || SUPERLATIVE_RE.exec(sentence);
      if (!claimed) continue;

      const words = contentWords(sentence);

      // Escalate when the sentence repeats terms that were explicitly unknown.
      const sharedUnknown = new Set<string>();
      for (const w of words) if (ev.unknownWords.has(w)) sharedUnknown.add(w);
      if (sharedUnknown.size >= 2) {
        claimsOk = false;
        issues.push(issue("business-safety", "critical",
          "Website states something that was explicitly marked as unknown.",
          f.path, sentence, true, "remove-sentence", "unknown-stated"));
        continue;
      }

      // Location superlative must cite the verified location.
      const cityClaim = sentence.match(
        /(?:'s|\u2019s)\s+leading|best\s+(?:in|near|around|at|for|of)\s+([A-Z][a-z]+)/,
      );
      if (cityClaim) {
        const cited = cityClaim[1]?.toLowerCase() ?? null;
        if (!ev.city || (cited && cited !== ev.city.toLowerCase())) {
          claimsOk = false;
          issues.push(issue("business-safety", "critical",
            "Superlative claim cites a location that is not verified.",
            f.path, sentence, true, "remove-sentence", "location-claim"));
          continue;
        }
        if (cited) {
          // Verified location in a superlative is allowed by the spec; skip
          // the generic overlap test that would otherwise reject the praise.
          continue;
        }
      }

      // A claim is supported only when its distinctive words also appear in the
      // verified evidence set (services, audience, name, verified-fact text).
      if (!hasIntersection(words, ev.evidenceWords)) {
        claimsOk = false;
        issues.push(issue("business-safety", "high",
          "Unsupported claim: the website asserts something not present in verified facts.",
          f.path, sentence, true, "remove-sentence", "unsupported-claim"));
      }

      // Target-niche hint: asserting the campaign niche without verified support
      // must be rejected even though the niche itself is not evidence. Word
      // prefixes are matched so plurals (e.g. "weddings") still count as claims
      // of the niche ("wedding").
      if (ev.nicheTerms.length > 0) {
        const nicheWords = [...contentWords(ev.nicheTerms.join(" "))].filter(
          (t) => t.length >= 4,
        );
        const couldClaimNiche =
          nicheWords.length > 0 &&
          [...words].some((w) =>
            nicheWords.some((nw) => w.startsWith(nw) || nw.startsWith(w)),
          );
        if (couldClaimNiche && !hasIntersection(words, ev.evidenceWords)) {
          claimsOk = false;
          issues.push(issue("business-safety", "critical",
            "Website asserts a specialization that is not supported by verified evidence.",
            f.path, sentence, true, "remove-sentence", "niche-claim"));
        }
      }
    }
  }

  checks.push(check("qa-check-business-claims",
    "Website copy is supported by verified facts", "business-safety",
    claimsOk, claimsOk ? undefined : "an unsupported business claim was found"));
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function anyIssueAtOrAbove(issues: QaIssue[], min: QaSeverity): boolean {
  const rank: Record<QaSeverity, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  return issues.some((i) => rank[i.severity] >= rank[min]);
}

export function runQaAudit(input: QaAuditInput): QaResult {
  issueCounter = 0;
  const { files, refs, build } = input;
  const issues: QaIssue[] = [];
  const checks: QaCheck[] = [];
  const ev = collectEvidence(refs);

  checkStructure(files, refs, build, issues, checks);
  checkLinks(files, issues, checks);
  checkContact(files, ev, issues, checks);
  checkContent(files, ev, issues, checks);
  checkResponsive(files, issues, checks);
  checkAccessibility(files, issues, checks);
  checkViewport(files, issues, checks);
  checkBusinessSafety(files, ev, issues, checks);

  const status: QaResult["status"] = anyIssueAtOrAbove(issues, "medium")
    ? "FAIL"
    : "PASS";

  let score = 100;
  for (const i of issues) {
    score -= i.severity === "critical" ? 40 : i.severity === "high" ? 20 : i.severity === "medium" ? 8 : 3;
  }
  score = Math.max(0, Math.min(100, score));

  const inCategories = (cats: QaIssue["category"][]): QaIssue[] =>
    issues.filter((i) => cats.includes(i.category));

  const contentAudit: QaAudit = {
    passed: !anyIssueAtOrAbove(inCategories(["content"]), "medium"),
    checks: checks.filter((c) => c.category === "content"),
    issues: inCategories(["content"]),
  };
  const safetyAudit: QaAudit = {
    passed: !anyIssueAtOrAbove(inCategories(["structural", "contact", "link", "business-safety"]), "medium"),
    checks: checks.filter((c) =>
      ["structural", "contact", "link", "business-safety"].includes(c.category),
    ),
    issues: inCategories(["structural", "contact", "link", "business-safety"]),
  };
  const accessibilityAudit: QaAudit = {
    passed: !anyIssueAtOrAbove(inCategories(["accessibility", "responsive"]), "medium"),
    checks: checks.filter((c) => ["accessibility", "responsive"].includes(c.category)),
    issues: inCategories(["accessibility", "responsive"]),
  };

  const recommendations = issues
    .filter((i) => i.severity === "low")
    .map((i) => `Fix ${i.id}: ${i.description}`);

  return {
    status,
    score,
    issues,
    fixedIssues: [],
    remainingIssues: issues,
    checks,
    contentAudit,
    safetyAudit,
    accessibilityAudit,
    recommendations,
  };
}