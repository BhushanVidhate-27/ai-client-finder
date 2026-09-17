import { NextResponse } from "next/server";
import { getOutreachSendByKey } from "@/lib/data/outreach";
import { logActivity } from "@/lib/data/activity";
import { requireAuth, unauthorizedResponse, isSameOriginRequest } from "@/lib/auth/http";
import {
  sendControlledEmail,
  ControlledSendBlockedError,
  EmailTransportError,
} from "@/lib/email-transport/controlled-send";

export const dynamic = "force-dynamic";

interface SendTestBody {
  prospectId?: unknown;
  draftId?: unknown;
  confirm?: unknown;
}

/**
 * Fields that are NEVER accepted from the client. The server resolves every
 * one of them from persisted, approved state; the browser is never
 * authoritative for recipient, subject, body, from address, content hash,
 * website version, campaign context or provider. Their presence is rejected.
 */
const DISALLOWED_CLIENT_FIELDS = [
  "recipientEmail",
  "recipient",
  "recipients",
  "to",
  "subject",
  "body",
  "html",
  "fromEmail",
  "from",
  "contentHash",
  "hash",
  "websiteVersion",
  "websiteVersionId",
  "website",
  "provider",
  "providerId",
  "leads",
  "leadIds",
  "ids",
  "campaignId",
  "campaign",
  "sendAll",
  "bulk",
  "mode",
  "execute",
  "status",
];

/**
 * POST /api/admin/outreach/send-test
 *
 * Admin-only, single-recipient real-email send control. Sends exactly ONE
 * email, to exactly ONE verified prospect, from the approved draft, through
 * the Resend provider — and ONLY when every safety gate passes:
 *
 *   Agent 8 SEND → human approval → Agent 10 TRANSPORT_READY → Resend.
 *
 * The request carries only { prospectId, draftId, confirm: true }. All email
 * content, recipient, from address, version and provider are resolved
 * server-side from approved persisted state.
 *
 * Unauthenticated → 401. Cross-origin/non-POST → rejected. confirm !== true →
 * 400. Any gate failure → 4xx with a safe normalized code and NO Resend call.
 * Provider failure → 502 with a safe normalized code; never raw provider
 * output and never a secret.
 */
export async function POST(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  // Defense-in-depth CSRF (the proxy also enforces same-origin).
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: SendTestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  // Reject any client-supplied authoritative field outright.
  for (const key of DISALLOWED_CLIENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      return NextResponse.json(
        { error: `Field "${key}" is not accepted; all send content is resolved server-side.` },
        { status: 400 },
      );
    }
  }

  if (body.confirm !== true) {
    return NextResponse.json(
      { error: "Explicit confirmation (confirm: true) is required to send one email." },
      { status: 400 },
    );
  }

  const prospectId = typeof body.prospectId === "string" ? body.prospectId : "";
  const draftId = typeof body.draftId === "string" ? body.draftId : "";
  if (!prospectId || !draftId) {
    return NextResponse.json(
      { error: "prospectId and draftId are required." },
      { status: 400 },
    );
  }

  try {
    const result = await sendControlledEmail({
      prospectId,
      draftId,
      confirm: true,
    });

    const sendRow = getOutreachSendByKey(result.outcome.idempotencyKey);
    const delivery = sendRow
      ? {
          id: sendRow.id,
          provider: sendRow.provider,
          messageId: sendRow.messageId,
          status: sendRow.status,
          timestamp: sendRow.updatedAt,
        }
      : result.outcome.delivery
        ? {
            id: null,
            provider: result.outcome.delivery.providerId,
            messageId: result.outcome.delivery.messageId,
            status: result.outcome.delivery.status,
            timestamp: result.outcome.delivery.timestamp,
          }
        : null;

    logActivity({
      action: "outreach.sent",
      campaignId: null,
      leadId: prospectId,
      metadata: {
        draftId,
        idempotencyKey: result.outcome.idempotencyKey,
        messageId: delivery?.messageId ?? null,
        provider: "resend",
        status: result.status,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        status: result.status,
        duplicate: result.status === "duplicate",
        idempotencyKey: result.outcome.idempotencyKey,
        delivery,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof ControlledSendBlockedError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.httpStatus },
      );
    }
    // Provider failure already persisted a "failed" row by transportEmail.
    if (error instanceof EmailTransportError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code ?? "PROVIDER_UNKNOWN_ERROR",
          error: "The email provider rejected or failed the request.",
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { ok: false, code: "INTERNAL_ERROR", error: "Internal error." },
      { status: 500 },
    );
  }
}