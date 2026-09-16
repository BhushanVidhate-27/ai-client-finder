/**
 * Deterministic website-opportunity classification.
 *
 * A business is a sales opportunity only when its website is MISSING or
 * demonstrably inadequate. This module produces the deterministic evidence
 * (NO_WEBSITE / NEEDS_REDESIGN / GOOD_WEBSITE / UNKNOWN) that the Gemini
 * qualification step is required to treat as authoritative. Gemini may reason
 * about the evidence but must never invent website problems — and the final
 * qualification decision is applied here, deterministically, after Gemini.
 *
 * The probe reuses the existing URL safety/SSRF layer (assertSafeFetchUrl) and
 * never fetches private, reserved or metadata addresses. It never executes
 * shell commands. It follows only safe public redirects.
 */

import type { Lead } from "@/lib/google-places";
import { assertSafeFetchUrl, UnsafeUrlError } from "@/lib/url-safety";

export type WebsiteOpportunity =
  | "NO_WEBSITE"
  | "NEEDS_REDESIGN"
  | "GOOD_WEBSITE"
  | "UNKNOWN";

export const WEBSITE_OPPORTUNITY_ORDER: Record<WebsiteOpportunity, number> = {
  NO_WEBSITE: 0,
  NEEDS_REDESIGN: 1,
  UNKNOWN: 2,
  GOOD_WEBSITE: 3,
};

export const WEBSITE_OPPORTUNITY_LABELS: Record<WebsiteOpportunity, string> = {
  NO_WEBSITE: "No website",
  NEEDS_REDESIGN: "Needs redesign",
  GOOD_WEBSITE: "Good website",
  UNKNOWN: "Unknown",
};

/** Result of a single safe HTTP probe of one business website URL. */
export interface WebsiteProbe {
  /** True when a final HTTP response was received (any status). */
  reached: boolean;
  /** True when the site responded 2xx with an HTML document. */
  functioning: boolean;
  statusCode: number | null;
  contentType: string | null;
  finalUrl: string | null;
  redirectCount: number;
  /** Human-readable reason when the probe could not reach a usable site. */
  error: string | null;
  /** Ordered human-readable evidence statements. */
  evidence: string[];
}

export interface WebsiteOpportunityAssessment {
  classification: WebsiteOpportunity;
  url: string | null;
  reached: boolean;
  functioning: boolean;
  statusCode: number | null;
  contentType: string | null;
  finalUrl: string | null;
  evidence: string[];
  probedAt: string;
}

/** Injectable prober so tests never touch the real network. */
export type WebsiteProber = (url: string) => Promise<WebsiteProbe>;

/** Qualification shape the ranking only relies on. */
export interface LeadWithQualification {
  qualification: {
    qualified: boolean;
    opportunityScore: number;
    websiteOpportunity?: WebsiteOpportunity | null;
  };
}

const REQUEST_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const MAX_PROBE_BODY_BYTES = 65_536;
/** Text Search returns at most this many places per request. */
export const MAX_PLACES_PAGE = 20;
/** How many candidates we request per genuine opportunity wanted. */
export const DISCOVERY_POOL_MULTIPLIER = 3;

/**
 * Returns how many Google Places candidates to request so that a "find N
 * opportunities" request can surface enough candidates to actually find N
 * genuine opportunities. Capped at what the Places API hands back in one
 * request (MAX_PLACES_PAGE).
 */
export function discoveryPoolSize(leadCount: number): number {
  const raw = Math.max(leadCount, Math.ceil(leadCount * DISCOVERY_POOL_MULTIPLIER));
  return Math.min(raw, MAX_PLACES_PAGE);
}

function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return base === "text/html" || base === "application/xhtml+xml";
}

/**
 * Performs a safe, lightweight availability/quality probe of one URL.
 *
 * Safety: every hop (including each redirect target) is validated with
 * assertSafeFetchUrl before fetching, so private/reserved/metadata hosts are
 * never contacted. Only http/https redirects are followed, and at most
 * MAX_REDIRECTS of them. Does not judge appearance — only reachability,
 * status, content-type and a bounded body read.
 */
export async function probeWebsite(rawUrl: string): Promise<WebsiteProbe> {
  const evidence: string[] = [];
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return {
        reached: false,
        functioning: false,
        statusCode: null,
        contentType: null,
        finalUrl: null,
        redirectCount: hop,
        error: "Malformed website URL.",
        evidence: ["Website URL could not be parsed."],
      };
    }

    // SSRF gate for this hop — private/reserved/metadata hosts are refused.
    try {
      await assertSafeFetchUrl(currentUrl);
    } catch (error) {
      const reason =
        error instanceof UnsafeUrlError ? error.message : "Unsafe website URL.";
      return {
        reached: false,
        functioning: false,
        statusCode: null,
        contentType: null,
        finalUrl: null,
        redirectCount: hop,
        error: reason,
        evidence: [`Website URL is not publicly fetchable: ${reason}`],
      };
    }

    evidence.push(`Probing ${parsed.origin} (${currentUrl})`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "AIClientFinderWebsiteProbe/1.0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        cache: "no-store",
      });
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "Request timed out"
          : error instanceof Error
            ? error.message
            : "Fetch failed";
      return {
        reached: false,
        functioning: false,
        statusCode: null,
        contentType: null,
        finalUrl: null,
        redirectCount: hop,
        error: message,
        evidence: [...evidence, `Website could not be reached: ${message}`],
      };
    } finally {
      clearTimeout(timer);
    }

    if (response.redirected) {
      currentUrl = response.url;
      continue;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          reached: false,
          functioning: false,
          statusCode: response.status,
          contentType: null,
          finalUrl: response.url || currentUrl,
          redirectCount: hop,
          error: "Redirect without a Location header.",
          evidence: [...evidence, `Redirect (${response.status}) had no Location header.`],
        };
      }
      try {
        currentUrl = new URL(location, currentUrl).href;
        continue;
      } catch {
        return {
          reached: false,
          functioning: false,
          statusCode: response.status,
          contentType: null,
          finalUrl: response.url || currentUrl,
          redirectCount: hop,
          error: "Invalid redirect target.",
          evidence: [...evidence, `Redirect (${response.status}) pointed at an invalid URL.`],
        };
      }
    }

    // We reached a real response.
    const contentType = response.headers.get("content-type") ?? null;
    const finalUrl = response.url || currentUrl;

    // Consume a bounded slice so the socket is released without pulling a huge
    // page. The bytes themselves are only used as a liveness signal.
    let bodyBytes = 0;
    try {
      const reader = response.body?.getReader();
      if (reader) {
        while (bodyBytes < MAX_PROBE_BODY_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          bodyBytes += value.byteLength;
        }
        await reader.cancel().catch(() => undefined);
      }
    } catch {
      // Body read failures are not classification evidence on their own.
    }

    if (response.ok) {
      if (isHtmlContentType(contentType)) {
        return {
          reached: true,
          functioning: true,
          statusCode: response.status,
          contentType,
          finalUrl,
          redirectCount: hop,
          error: null,
          evidence: [
            ...evidence,
            `Website reachable with status ${response.status} and serves HTML.`,
          ],
        };
      }
      return {
        reached: true,
        functioning: false,
        statusCode: response.status,
        contentType,
        finalUrl,
        redirectCount: hop,
        error: "Website does not serve an HTML page.",
        evidence: [
          ...evidence,
          `Website responds (status ${response.status}) but content type is "${contentType ?? "unknown"}".`,
        ],
      };
    }

    // Error status. 401/403/429 are not treated as "broken" because the site
    // may simply be blocking our probes; there is not enough evidence.
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      return {
        reached: true,
        functioning: false,
        statusCode: response.status,
        contentType,
        finalUrl,
        redirectCount: hop,
        error: `Website may be blocking automated access (status ${response.status}).`,
        evidence: [
          ...evidence,
          `Website returned status ${response.status}; cannot confirm whether it serves a website.`,
        ],
      };
    }

    return {
      reached: true,
      functioning: false,
      statusCode: response.status,
      contentType,
      finalUrl,
      redirectCount: hop,
      error: `Website returned error status ${response.status}.`,
      evidence: [
        ...evidence,
        `Website returned error status ${response.status}.`,
      ],
    };
  }

  return {
    reached: false,
    functioning: false,
    statusCode: null,
    contentType: null,
    finalUrl: null,
    redirectCount: MAX_REDIRECTS,
    error: "Too many redirects.",
    evidence: ["Website redirect chain never settled."],
  };
}

/**
 * Maps a single lead's website presence + probe result to a deterministic
 * opportunity classification. Pure: no network access.
 */
export function classifyLead(
  lead: Pick<Lead, "websiteUrl">,
  probeResult: WebsiteProbe | null,
): WebsiteOpportunityAssessment {
  const url = lead.websiteUrl?.trim() || null;
  const now = new Date().toISOString();

  if (!url) {
    return {
      classification: "NO_WEBSITE",
      url: null,
      reached: false,
      functioning: false,
      statusCode: null,
      contentType: null,
      finalUrl: null,
      evidence: ["No website URL listed by Google Places."],
      probedAt: now,
    };
  }

  if (!probeResult) {
    return {
      classification: "UNKNOWN",
      url,
      reached: false,
      functioning: false,
      statusCode: null,
      contentType: null,
      finalUrl: null,
      evidence: ["Website status could not be verified."],
      probedAt: now,
    };
  }

  return {
    classification: classifyFromProbe(probeResult),
    url,
    reached: probeResult.reached,
    functioning: probeResult.functioning,
    statusCode: probeResult.statusCode,
    contentType: probeResult.contentType,
    finalUrl: probeResult.finalUrl,
    evidence: probeResult.evidence,
    probedAt: now,
  };
}

function classifyFromProbe(probe: WebsiteProbe): WebsiteOpportunity {
  if (probe.functioning) return "GOOD_WEBSITE";
  if (probe.reached) {
    // Server responded, but not with a functioning website. A broken page,
    // redirect loop, or non-HTML endpoint is evidence the website is
    // inadequate; a bot-block (401/403/429) is not enough evidence to claim
    // that, so it is UNKNOWN.
    if (probe.statusCode === 401 || probe.statusCode === 403 || probe.statusCode === 429) {
      return "UNKNOWN";
    }
    if (probe.statusCode !== null && probe.statusCode >= 200 && probe.statusCode < 400) {
      return "UNKNOWN";
    }
    return "NEEDS_REDESIGN";
  }
  // Never reached: refused, DNS failure, timeout, redirect loop, unsafe host,
  // or invalid URL. A publicly unfetchable URL is either clearly broken or
  // not verifiable. Distinguish safety blocks (no evidence) from failures.
  if (probe.error && /not publicly fetchable|unsafe|blocked|private|reserved/i.test(probe.error)) {
    return "UNKNOWN";
  }
  return "NEEDS_REDESIGN";
}

/** Classifies a batch of leads, deduplicating probes by website URL. */
export async function classifyLeads(
  leads: Lead[],
  probe: WebsiteProber = probeWebsite,
  concurrency = 4,
): Promise<Map<string, WebsiteOpportunityAssessment>> {
  const results = new Map<string, WebsiteOpportunityAssessment>();
  const probeCache = new Map<string, Promise<WebsiteProbe>>();

  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < leads.length) {
      const index = nextIndex;
      nextIndex += 1;
      const lead = leads[index];
      const url = lead.websiteUrl?.trim() || null;
      let probeResult: WebsiteProbe | null = null;
      if (url) {
        if (!probeCache.has(url)) {
          probeCache.set(
            url,
            probe(url).catch((error) => ({
              reached: false,
              functioning: false,
              statusCode: null,
              contentType: null,
              finalUrl: null,
              redirectCount: 0,
              error: error instanceof Error ? error.message : "Probe failed.",
              evidence: ["Website probe failed unexpectedly."],
            })) as Promise<WebsiteProbe>,
          );
        }
        probeResult = await probeCache.get(url)!;
      }
      results.set(lead.placeId, classifyLead(lead, probeResult));
    }
  };

  const workerCount = Math.min(concurrency, leads.length);
  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  return results;
}

/**
 * Ranks qualified leads as prospects: NO_WEBSITE first, NEEDS_REDESIGN next,
 * each tie broken by opportunity score descending. GOOD_WEBSITE and UNKNOWN
 * leads are never genuine prospects and are dropped. Returns at most `limit`
 * prospects — fewer when fewer genuine opportunities exist. Never pads.
 */
export function selectProspects<T extends LeadWithQualification>(
  leads: T[],
  limit: number,
): T[] {
  const genuine = leads.filter((lead) => {
    if (!lead.qualification?.qualified) return false;
    const opportunity = lead.qualification.websiteOpportunity;
    return opportunity === "NO_WEBSITE" || opportunity === "NEEDS_REDESIGN";
  });

  genuine.sort((a, b) => {
    const aa = WEBSITE_OPPORTUNITY_ORDER[a.qualification.websiteOpportunity!];
    const bb = WEBSITE_OPPORTUNITY_ORDER[b.qualification.websiteOpportunity!];
    if (aa !== bb) return aa - bb;
    return b.qualification.opportunityScore - a.qualification.opportunityScore;
  });

  return genuine.slice(0, limit);
}