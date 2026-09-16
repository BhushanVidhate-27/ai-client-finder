/**
 * Campaign Execution (Step 16) — deterministic outreach draft generation.
 *
 * This is the ONLY draft text the campaign runner ever writes. It is built
 * purely from trusted application state (the business name and the verified
 * deployment URL), contains no invented facts, and is written to pass the
 * Agent 8 deterministic content scan so the next evaluation can reach
 * WAIT_FOR_OUTREACH_APPROVAL instead of being blocked by unsafe copy.
 *
 * The copy deliberately avoids: unsupported service claims, niche-as-fact,
 * pricing/urgency/awards/credentials, quoted conversations, fake compliments,
 * opt-out language, and prompt-injection phrasing.
 */

export interface SafeDraftInput {
  businessName: string;
  websiteUrl: string;
}

export interface SafeDraftOutput {
  subject: string;
  body: string;
}

/**
 * Builds a safe, deterministic outreach draft. `websiteUrl` must be the
 * verified (ready, live) deployment URL of the current website version.
 */
export function buildSafeOutreachDraft(input: SafeDraftInput): SafeDraftOutput {
  const name = input.businessName.trim() || "your business";
  const url = input.websiteUrl.trim();

  const subject = `Your ${name} website is live`;
  const body = [
    `Hello ${name} team,`,
    "",
    `Your new website is live at ${url}. We built it to make it easy for people to find you and reach out.`,
    "",
    "If you would like to make any changes or ask a question, just reply here and we will help.",
    "",
    "Best regards,",
    "The Website Team",
  ].join("\n");

  return { subject, body };
}