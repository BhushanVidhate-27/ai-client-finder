import { NextResponse } from "next/server";
import { getLeadById } from "@/lib/data/leads";
import {
  getOutreachDraft,
  getOutreachOptOut,
} from "@/lib/data/outreach";
import { getCampaign, listCampaignIdsByLeadId } from "@/lib/data/campaigns";
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
 * Read-only safety preview for the admin confirmation UI. This endpoint NEVER
 * sends anything and performs NO side effects: both Agent 8 (with
 * recordAuthorization: false) and Agent 10 are evaluated as pure readers of
 * persisted state, so evaluating the preview can never create a send
 * authorization, write a row, or contact a provider.
 *
 * The response contains only safe, admin-visible summary values resolved from
 * server state — business name, verified recipient, approved subject, the
 * fixed provider, and the current Agent 8 / Agent 10 decisions. It never
 * includes subject/body/from/version/provider inputs from the browser, never
 * returns secrets, and exposes nothing the lead-detail admin view does not
 * already show.
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

  return NextResponse.json({
    ok: true,
    ready,
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
      status: draft.status,
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
  });
}