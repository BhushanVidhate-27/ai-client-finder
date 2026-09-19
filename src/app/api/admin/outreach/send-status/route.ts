import { NextResponse } from "next/server";
import { getLeadById } from "@/lib/data/leads";
import {
  getOutreachDraft,
  getOutreachOptOut,
} from "@/lib/data/outreach";
import { getCampaign, listCampaignIdsByLeadId } from "@/lib/data/campaigns";
import { getCurrentWebsiteVersion } from "@/lib/data/websites";
import {
  evaluateSendSafety,
  normalizeRecipientEmail,
} from "@/lib/outreach-safety/safety";
import { evaluateTransportSafety } from "@/lib/transport-safety";
import { isResendProviderReady } from "@/lib/email-transport/config";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/outreach/send-status?prospectId=&draftId=
 *
 * Read-only real-email preflight for the admin confirmation UI. This endpoint
 * NEVER sends anything and performs NO side effects: both Agent 8 (with
 * recordAuthorization: false) and Agent 10 are evaluated as pure readers of
 * persisted state, so evaluating the preview can never create a send
 * authorization, write a row, claim an idempotency key, or contact a provider.
 *
 * It reports exactly what the controlled send path would send, resolved
 * exclusively from server-side persisted state: prospect/business, verified
 * recipient, approved subject, approved body, content hash, current website
 * version id, live deployment URL, deployment artifact hash, campaign state,
 * opt-out, provider configuration, both agent decisions, the exact approval
 * binding, and a per-gate breakdown (the agents' deterministic checks).
 *
 * Security:
 * - no secrets, API keys, Authorization headers, or raw provider responses
 * - the from address is intentionally NOT exposed (not part of the admin UI
 *   conventions today); provider output is limited to { id, configured }
 * - the client cannot influence any value; recipient/subject/body/hash/version/
 *   deployment/provider are all read from trusted persisted state, and the
 *   request carries only prospectId + draftId
 * - the final result is READY only when Agent 8 is SEND, Agent 10 is
 *   TRANSPORT_READY, and no prior send exists for this exact outreach — the
 *   same authoritative gates the actual send must pass
 *
 * Unauthenticated -> 401. Unknown prospect/draft or a draft bound to a
 * different prospect -> 4xx. The UI uses this status to gate the confirmation
 * dialog; the actual send still requires the authenticated POST mutation with
 * confirm: true on /api/admin/outreach/send-test.
 */
export async function GET(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const url = new URL(request.url);
  const prospectId = url.searchParams.get("prospectId") ?? "";
  const draftId = url.searchParams.get("draftId") ?? "";
  if (!prospectId || !draftId) {
    return NextResponse.json(
      { error: "prospectId and draftId are required." },
      { status: 400 },
    );
  }

  const lead = getLeadById(prospectId);
  if (!lead) {
    return NextResponse.json(
      { error: "Prospect not found." },
      { status: 404 },
    );
  }

  const draft = getOutreachDraft(draftId);
  if (!draft) {
    return NextResponse.json(
      { error: "Draft not found." },
      { status: 404 },
    );
  }
  if (draft.leadId !== prospectId) {
    return NextResponse.json(
      { error: "Draft does not belong to this prospect." },
      { status: 422 },
    );
  }

  const contact = lead.contactDiscovery;
  const recipientEmail =
    contact?.emailStatus === "found" &&
    (contact.emailConfidence === "high" ||
      contact.emailConfidence === "medium") &&
    contact.email
      ? normalizeRecipientEmail(contact.email)
      : null;

  const campaignId =
    lead.campaignId ?? listCampaignIdsByLeadId(prospectId)[0] ?? null;
  const campaign = campaignId ? getCampaign(campaignId) : null;

  const agent8 = evaluateSendSafety(
    { leadId: prospectId, draftId, recipientEmail: recipientEmail ?? "" },
    { recordAuthorization: false },
  );
  const agent10 = evaluateTransportSafety({
    leadId: prospectId,
    draftId,
    recipientEmail: recipientEmail ?? "",
    campaignId,
    agent8Decision: agent8.decision,
    provider: "resend",
  });

  const currentVersion = getCurrentWebsiteVersion(prospectId);
  const alreadySent = agent8.idempotency.alreadyProcessed;
  const ready =
    agent8.decision === "SEND" &&
    agent10.decision === "TRANSPORT_READY" &&
    !alreadySent;
  const blockedReason =
    agent8.decision !== "SEND"
      ? agent8.reason
      : agent10.decision !== "TRANSPORT_READY"
        ? agent10.reason
        : alreadySent
          ? "This exact outreach was already sent or is being sent."
          : null;

  // Presentation-only adaptation of the agents' check arrays (the core agents
  // are NOT modified):
  // - agent8's "authorized" check claims "Authorization persisted". That is
  //   true only for the recordAuthorization path; this read-only preflight uses
  //   recordAuthorization: false and writes nothing, so the claim would be
  //   false. It is excluded here to keep the preflight truthful.
  // - agent10's "provider" check is the engine's initial-state placeholder and
  //   is always passed:false even when READY; the real provider gates are
  //   provider_supported + provider_configured. It is excluded here so a ready
  //   preflight does not report a phantom failing gate.
  // - detail is surfaced only on failed gates; the agents' passed-gate fallback
  //   detail strings can read as failures ("Approval is not bound to this
  //   prospect.") on gates that actually passed.
  const gates = [
    ...agent8.checks
      .filter((c) => c.id !== "authorized")
      .map((c) => ({
        id: `outreach.${c.id}`,
        label: c.label,
        passed: c.passed,
        ...(c.passed ? {} : c.detail ? { detail: c.detail } : {}),
      })),
    ...agent10.checks
      .filter((c) => c.id !== "provider")
      .map((c) => ({
        id: `transport.${c.id}`,
        label: c.label,
        passed: c.passed,
        ...(c.passed ? {} : c.detail ? { detail: c.detail } : {}),
      })),
  ];

  return NextResponse.json({
    ok: true,
    ready,
    result: ready ? "READY" : "NOT_READY",
    alreadySent,
    blockedReason,
    prospect: {
      id: lead.id,
      businessName: lead.businessName,
    },
    recipientEmail,
    draft: {
      id: draft.id,
      subject: draft.subject,
      body: draft.body,
      contentHash: draft.contentHash,
      status: draft.status,
    },
    websiteVersion: {
      id: currentVersion?.projectId ?? agent10.website.currentVersionId ?? null,
      deploymentUrl: agent10.website.deploymentUrl ?? null,
      deploymentStatus: agent10.website.deploymentStatus ?? null,
      artifactHash: currentVersion?.artifactHash ?? null,
    },
    campaign: {
      id: campaignId,
      status: campaign?.status ?? null,
    },
    optOut: getOutreachOptOut(prospectId) !== null,
    provider: {
      id: "resend",
      configured: isResendProviderReady(),
    },
    agent8: { decision: agent8.decision },
    agent10: { decision: agent10.decision },
    approval: agent10.approval,
    gates,
  });
}