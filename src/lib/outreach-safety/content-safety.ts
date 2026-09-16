/**
 * Outreach Send Safety (Agent 8) — deterministic content-risk rules.
 *
 * Everything passed to these functions is UNTRUSTED: draft subject/body,
 * prospect replies, previous emails, research notes, website copy, filenames,
 * workspace metadata. Trusted application state (DB rows) is the ONLY source
 * of authorization; this module returns findings that can ONLY block.
 *
 * No LLM is involved. The rules mirror the A6/QA safety categories: unsupported
 * claims about services, years of experience, clients, awards, credentials,
 * testimonials, pricing, owner names, private information, fake conversations,
 * fake compliments, fake hosting claims, and prompt-injection attempts.
 */

export interface SafetyFinding {
  ruleId: string;
  message: string;
}

const OPTOUT_SIGNALS: ReadonlyArray<{ ruleId: string; pattern: RegExp }> = [
  { ruleId: "optout-unsubscribe", pattern: /\bunsubscribe\b/i },
  { ruleId: "optout-optout", pattern: /\bopt\s*-?\s*out\b/i },
  { ruleId: "optout-do-not-contact", pattern: /\bdo\s+not\s+contact\b/i },
  { ruleId: "optout-do-not-email", pattern: /\bdo\s+not\s+(email|e-?mail)\b/i },
  { ruleId: "optout-stop-emailing", pattern: /\bstop\s+(email|emailing|e-?mailing)\b/i },
  { ruleId: "optout-remove-me", pattern: /\bremove\s+me\b/i },
  { ruleId: "optout-no-solicitation", pattern: /\bno\s+solicitation\b/i },
  { ruleId: "optout-dont-contact-again", pattern: /\b(don'?t|do\s+not)\s+contact\s+(me|us)\s+again\b/i },
  { ruleId: "optout-take-me-off", pattern: /\btake\s+me\s+off\b/i },
  { ruleId: "optout-lost-interest", pattern: /\b(not\s+)?interested\s*(please\s+)?(in\s+)?(any\s+)?(future\s+)?(emails|contact|services)?\b/i },
];

/** Prompt-injection / fake-authorization attempts inside UNTRUSTED content. */
const INJECTION_PATTERNS: ReadonlyArray<{ ruleId: string; pattern: RegExp }> = [
  { ruleId: "inject-send-immediately", pattern: /\bsend\s+immediately\b/i },
  { ruleId: "inject-admin-approved", pattern: /\badmin(istrator)?\s*(has\s*)?(approved|authori[sz]ed)\b/i },
  { ruleId: "inject-ignore-optout", pattern: /\bignore\s+(the\s+)?opt-?\s*out\b/i },
  { ruleId: "inject-use-email", pattern: /\buse\s+this\s+email\s+instead\b/i },
  { ruleId: "inject-use-address", pattern: /\b(use|send\s+to)\s+this\s+(address|email)\b/i },
  { ruleId: "inject-skip-verification", pattern: /\bskip\s+verification\b/i },
  { ruleId: "inject-no-verification", pattern: /\b(do\s+not|dont|never)\s+(verify|check|validate|review)\b/i },
  { ruleId: "inject-ignore-rules", pattern: /\bignore\s+(all\s+|the\s+)?(rules|instructions|previous\s+instructions)\b/i },
  { ruleId: "inject-approved", pattern: /\b(this|email|draft)\s*(is|has\s+been|was)\s*(already)?\s*(approved|authori[sz]ed)(\s+by\s+\w+)?\b/i },
];

/** Unsupported/private claim patterns from untrusted draft copy. */
const UNSAFE_CLAIM_PATTERNS: ReadonlyArray<{ ruleId: string; message: string; pattern: RegExp }> = [
  {
    ruleId: "claim-years",
    message: "Unsupported years-of-experience claim.",
    pattern: /\b\d{1,3}\s*(years|yrs\.?|years?)\s*(of)?\s*(experience|in\s+business|serving|of\s+service)\b/i,
  },
  {
    ruleId: "claim-award",
    message: "Unsupported award/ranking claim.",
    pattern: /\b(award[^\s]*|winner|ranked|top\s+(\d+|rated)|#\s?\d+|best\s+of|recognized|featured\s+in|press)\b/i,
  },
  {
    ruleId: "claim-credential",
    message: "Unsupported credential/certification claim.",
    pattern: /\b(certified|certification|accredited|credential[^\s]*|licensed|degree|member\s+of)\b/i,
  },
  {
    ruleId: "claim-pricing",
    message: "Unsupported pricing claim.",
    pattern: /\b(\$\s?\d+|\bprice[s]?\b|\bpr[oí]cing\b|\bcost[s]?\b|\brates?\b|\baffordable\b|\bbudget\b)\b/i,
  },
  {
    ruleId: "claim-testimonial",
    message: "Unsupported testimonial/review claim.",
    pattern:
      /\b(customers?|clients?|users?|reviewer)\b[^.\n]{0,50}\b(say|says|said|love|loves|rave|recommend|praise)\b|"[^"]{10,}"\s*[—–-]\s*[^"\\n]/i,
  },
  {
    ruleId: "claim-client-name",
    message: "Unsupported named-client reference.",
    pattern: /\b(for|with|to|at)\s+[A-Z][A-Za-z0-9&'.-]*\s+(clients?|businesses?|brands?|companies?|partners?)\b/i,
  },
  {
    ruleId: "claim-owner",
    message: "Unsupported owner/principal reference (private information).",
    pattern:
      /\b(owner|founder|ceo|proprietor|principal|manager|director|president)\b[^.\n]{0,60}\b[A-Z][a-z]+([\s-][A-Z][a-z]+)?\b/i,
  },
  {
    ruleId: "claim-private-info",
    message: "Unsupported private contact information.",
    pattern: /\b(phone|mobile|cell|direct\s+line|email|e-?mail|address)\s*[:#]?\s*(\(?\d{3}\)?[\s.-]?\d{3}|[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+)\b/i,
  },
  {
    ruleId: "claim-fake-conversation",
    message: "Unsupported fabricated conversation.",
    pattern: /"[^"]{4,}"\s*[—–-]?\s*(said|told|mentioned|replied|asked|wrote)|(i\s+(asked|called|spoke|talked|visited))\b[^.\n]{0,40}"[^"]{4,}"/i,
  },
];

const FAKE_COMPLIMENT_WORDS = /\b(impressed|thrilled|excited|delighted|overjoyed|amazed|ecstatic|love[d]?\s+your)\b/i;

/** Claims that "we built / the site is live" — only provable by deployment DB state. */
export const LIVE_SITE_CLAIM_PATTERN =
  /\b(your\s+(new\s+)?website\s+(is|to\s+be)\s+(live|launched|ready|up|built|created|deployed))|\b((we|i)\s+(built|created|deployed|launched|made|redesigned|rebuilt|moderni[sz]ed|pushed\s+live)\s+your\s+(new\s+)?website)\b/i;

/** A claim that the prospect themselves provides a service ("you offer X"). */
const PROSPECT_SERVICE_CLAIM =
  /\b(you|your\s+(business|company|firm|practice|team))\s+(offer|offers|provide|provides|speciali[sz]e|speciali[sz]es|deal|deals|handle|handles)\b[^.\n]{0,80}/i;

const NICHED_AS_SERVICE_CLAIM =
  /\b(you\s+(provide|offer|speciali[sz]e)\s+in|[a-z\s-]+services\b)/i;

/**
 * Returns true when untrusted text contains an explicit opt-out signal.
 * Recognized: unsubscribe, opt out, do not contact, don't contact me again,
 * stop emailing, remove me, no solicitation.
 */
export function detectOptOutSignal(text: string): SafetyFinding[] {
  const normalized = text.toLowerCase();
  const findings: SafetyFinding[] = [];
  for (const signal of OPTOUT_SIGNALS) {
    if (signal.pattern.test(normalized)) {
      findings.push({
        ruleId: signal.ruleId,
        message: `Explicit opt-out signal detected: ${signal.ruleId}.`,
      });
    }
  }
  return findings;
}

/** Detects prompt-injection / fake-authorization instructions in untrusted content. */
export function detectInjectionAttempts(text: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const injection of INJECTION_PATTERNS) {
    if (injection.pattern.test(text)) {
      findings.push({
        ruleId: injection.ruleId,
        message: `Ignored untrusted instruction: ${injection.ruleId}.`,
      });
    }
  }
  return findings;
}

function claimMatches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

/**
 * Deterministic content-risk scan of untrusted draft copy. Never authorizes;
 * any returned finding blocks SEND. `verifiedServices` (trusted research) and
 * `niche` (trusted campaign label) are used only to reject claims that are not
 * backed by verified evidence.
 */
export function scanDraftContent(
  input: {
    subject: string | null;
    body: string;
  },
  context: {
    verifiedServices?: string[];
    niche?: string;
  } = {},
): SafetyFinding[] {
  const text = [input.subject ?? "", input.body].join("\n");
  const findings: SafetyFinding[] = [];

  for (const injection of INJECTION_PATTERNS) {
    if (injection.pattern.test(text)) {
      findings.push({
        ruleId: injection.ruleId,
        message: `Draft contains an untrusted instruction (${injection.ruleId}) that cannot authorize sending.`,
      });
    }
  }

  if (LIVE_SITE_CLAIM_PATTERN.test(text)) {
    findings.push({
      ruleId: "claim-fake-hosting",
      message:
        "Draft claims the prospect's website is live/built by us without a verified deployment. " +
        "Only deployment state may prove this.",
    });
  }

  if (FAKE_COMPLIMENT_WORDS.test(text)) {
    findings.push({
      ruleId: "claim-fake-compliment",
      message: "Draft asserts an emotional/excited reaction about the prospect that is not verified.",
    });
  }

  for (const rule of UNSAFE_CLAIM_PATTERNS) {
    if (claimMatches(rule.pattern, text)) {
      findings.push({ ruleId: rule.ruleId, message: rule.message });
    }
  }

  // Unsupported service claim about the prospect: "you offer X" where X is not
  // among the verified services of the prospect.
  if (PROSPECT_SERVICE_CLAIM.test(text)) {
    const services = (context.verifiedServices ?? []).map((s) =>
      s.trim().toLowerCase(),
    );
    const claim = PROSPECT_SERVICE_CLAIM.exec(text)?.[0] ?? text;
    const unsupported = !services.some(
      (service) =>
        claim.toLowerCase().includes(service) ||
        service
          .split(/\s+/)
          .some((word) => word.length >= 4 && claim.toLowerCase().includes(word)),
    );
    if (unsupported) {
      findings.push({
        ruleId: "claim-invented-service",
        message: "Draft asserts a prospect service that is not backed by verified evidence.",
      });
    }
  }

  // The campaign niche is never proof of a business service.
  if (context.niche) {
    const niche = context.niche.trim().toLowerCase();
    if (niche && NICHED_AS_SERVICE_CLAIM.test(text)) {
      const mentionsNiche =
        text.toLowerCase().includes(niche) ||
        niche.split(/\s+/).some((word) => word.length >= 5 && text.toLowerCase().includes(word));
      const services = (context.verifiedServices ?? []).map((s) => s.toLowerCase());
      const supported = services.some((service) => {
        const serviceWords = service.split(/\s+/);
        const nicheWords = niche.split(/\s+/);
        return nicheWords.some((w) => service.includes(w)) ||
          serviceWords.some((w) => niche.includes(w));
      });
      if (mentionsNiche && !supported) {
        findings.push({
          ruleId: "claim-niche-as-fact",
          message: "Campaign niche is asserted about the prospect without verified evidence.",
        });
      }
    }
  }

  return findings;
}