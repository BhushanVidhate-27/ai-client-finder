import { NextResponse } from "next/server";
import { evaluateSendSafety } from "@/lib/outreach-safety/safety";
import { getLeadById } from "@/lib/data/leads";
import { getOutreachDraft } from "@/lib/data/outreach";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

interface EvaluateBody {
  leadId?: unknown;
  draftId?: unknown;
  recipientEmail?: unknown;
  replyText?: unknown;
  untrustedContext?: unknown;
  recordAuthorization?: unknown;
}

/**
 * POST /api/admin/outreach/safety
 *
 * Runs the deterministic send-safety evaluation for an exact outreach draft.
 * This endpoint NEVER sends anything. On a SEND decision it records a send
 * authorization so the same exact outreach can never be authorized twice;
 * pass `recordAuthorization: false` for a read-only evaluation.
 */
export async function POST(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  let body: EvaluateBody;
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
    typeof body.recipientEmail === "string" ? body.recipientEmail : undefined;
  const replyText =
    typeof body.replyText === "string" ? body.replyText : undefined;
  const untrustedContext =
    typeof body.untrustedContext === "object" && body.untrustedContext !== null
      ? (body.untrustedContext as Record<string, unknown>)
      : undefined;

  if (!leadId || !draftId) {
    return NextResponse.json(
      { error: "leadId and draftId are required." },
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

  const result = evaluateSendSafety(
    {
      leadId,
      draftId,
      recipientEmail,
      replyText,
      untrustedContext,
    },
    { recordAuthorization: body.recordAuthorization !== false },
  );

  return NextResponse.json({ ok: true, result });
}

/**
 * GET /api/admin/outreach/safety?leadId=
 *
 * Read-only safety status for a lead. Never records an authorization; reports
 * the deterministic decision a live evaluation would produce, alongside the
 * state (campaign, recipient verification, drafts, approvals, opt-outs).
 */
export async function GET(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const url = new URL(request.url);
  const leadId = url.searchParams.get("leadId") ?? "";
  if (!leadId) {
    return NextResponse.json(
      { error: "leadId query parameter is required." },
      { status: 400 },
    );
  }

  const lead = getLeadById(leadId);
  if (!lead) {
    return NextResponse.json({ error: "Lead not found." }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    recipientVerified:
      lead.contactDiscovery?.emailStatus === "found" &&
      (lead.contactDiscovery.emailConfidence === "high" ||
        lead.contactDiscovery.emailConfidence === "medium") &&
      Boolean(lead.contactDiscovery.email),
    contactEmail: lead.contactDiscovery?.email ?? null,
  });
}