import { NextResponse } from "next/server";
import { getLeadById } from "@/lib/data/leads";
import {
  createOutreachApproval,
  getOutreachDraft,
  hashOutreachDraft,
} from "@/lib/data/outreach";
import { getCampaign, listCampaignIdsByLeadId } from "@/lib/data/campaigns";
import { normalizeRecipientEmail, mapCampaignRunState } from "@/lib/outreach-safety/safety";
import { logActivity } from "@/lib/data/activity";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

interface ApproveBody {
  leadId?: unknown;
  draftId?: unknown;
  recipientEmail?: unknown;
}

/**
 * POST /api/admin/outreach/safety/approve
 *
 * Creates a human approval bound to the exact draft identity: the server
 * recomputes the draft hash itself (client hashes are never trusted), and the
 * recipient email must match the lead's verified contact email. Any previous
 * valid approval for the same draft is revoked first. Never sends anything.
 */
export async function POST(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  let body: ApproveBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const leadId = typeof body.leadId === "string" ? body.leadId : "";
  const draftId = typeof body.draftId === "string" ? body.draftId : "";
  const recipientEmail =
    typeof body.recipientEmail === "string" ? body.recipientEmail : "";

  if (!leadId || !draftId || !recipientEmail) {
    return NextResponse.json(
      { error: "leadId, draftId and recipientEmail are required." },
      { status: 400 },
    );
  }

  const lead = getLeadById(leadId);
  if (!lead) {
    return NextResponse.json({ error: "Lead not found." }, { status: 404 });
  }

  const draft = getOutreachDraft(draftId);
  if (!draft) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }
  if (draft.leadId !== leadId) {
    return NextResponse.json(
      { error: "Draft does not belong to this prospect." },
      { status: 400 },
    );
  }

  const email = normalizeRecipientEmail(recipientEmail);
  const contactEmail = lead.contactDiscovery?.email
    ? normalizeRecipientEmail(lead.contactDiscovery.email)
    : null;
  if (!contactEmail || contactEmail !== email) {
    return NextResponse.json(
      { error: "Recipient email does not match the verified contact email." },
      { status: 400 },
    );
  }

  const campaignId =
    lead.campaignId ?? listCampaignIdsByLeadId(leadId)[0] ?? null;
  const campaign = campaignId ? getCampaign(campaignId) : null;
  if (!campaign || mapCampaignRunState(campaign.status) !== "running") {
    return NextResponse.json(
      { error: "Campaign must be running to approve outreach." },
      { status: 409 },
    );
  }

  const approval = createOutreachApproval({
    leadId,
    draftId,
    recipientEmail: email,
    draftHash: hashOutreachDraft(draft.subject, draft.body),
    createdBy: sessionUser,
  });

  logActivity({
    action: "outreach.approved",
    leadId,
    metadata: { draftId, approvalId: approval.id },
  });

  return NextResponse.json({ ok: true, approval });
}