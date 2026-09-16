/**
 * Resend Email Transport Provider (Step 18).
 *
 * A real email provider adapter for the Resend API (https://resend.com).
 * Credentials are read from server-side environment variables only:
 *
 *   RESEND_API_KEY   — the Resend API key (required)
 *   RESEND_FROM_EMAIL — verified sender address (required)
 *
 * The adapter:
 *   - sends only the exact approved subject/body (never rewrites content),
 *   - sends only to the exact approved recipient,
 *   - reads the from address exclusively from server configuration,
 *   - never logs the API key,
 *   - never exposes the API key to clients or in error messages,
 *   - normalizes all provider errors into safe internal error codes,
 *   - returns the Resend message ID for audit persistence.
 *
 * The adapter MUST NOT be called unless all safety layers have passed:
 *   Agent 8 SEND → Agent 9 READY_FOR_TRANSPORT → Agent 10 TRANSPORT_READY.
 */

import { getOutreachSendByKey } from "@/lib/data/outreach";
import { readEmailTransportConfig } from "@/lib/email-transport/config";
import { EmailTransportError } from "@/lib/email-transport/service";
import { resendSafeFetchJson } from "@/lib/email-transport/providers/http";
import type {
  EmailDeliveryResult,
  EmailTransportProvider,
  EmailTransportRequest,
} from "@/lib/email-transport/types";

const RESEND_API_BASE = "https://api.resend.com";

interface ResendSendResponse {
  id: string;
  from?: string;
  to?: string[];
}

export class ResendEmailTransportProvider implements EmailTransportProvider {
  readonly providerId = "resend";
  readonly providerLabel = "Resend";
  readonly isMock = false;

  /**
   * Sends the approved email via the Resend API.
   *
   * Only a fully validated `EmailTransportRequest` is accepted — the request
   * carries the exact approved subject, body, and recipient. Nothing is
   * rewritten or generated.
   */
  async send(request: EmailTransportRequest): Promise<EmailDeliveryResult> {
    const config = readEmailTransportConfig();

    if (!config.resendApiKey) {
      throw new EmailTransportError(
        "Resend is not configured (RESEND_API_KEY is unset).",
        "PROVIDER_NOT_CONFIGURED",
      );
    }

    if (!config.resendFromEmail) {
      throw new EmailTransportError(
        "Resend is not configured (RESEND_FROM_EMAIL is unset).",
        "PROVIDER_NOT_CONFIGURED",
      );
    }

    const body = JSON.stringify({
      from: config.resendFromEmail,
      to: [request.recipientEmail],
      subject: request.subject,
      html: request.body,
      tags: [
        { name: "campaign_id", value: request.campaignId },
        { name: "prospect_id", value: request.prospectId },
        { name: "draft_id", value: request.draftId },
      ],
    });

    const response = await resendSafeFetchJson<ResendSendResponse>(
      `${RESEND_API_BASE}/emails`,
      {
        method: "POST",
        body,
        apiKey: config.resendApiKey,
      },
    );

    if (!response.id) {
      throw new EmailTransportError(
        "Resend returned a response without a message id.",
        "PROVIDER_UNKNOWN_ERROR",
      );
    }

    return {
      messageId: response.id,
      providerId: "resend",
      status: "sent",
      timestamp: new Date().toISOString(),
      idempotencyKey: request.idempotencyKey,
    };
  }

  /**
   * Read-only inspection of a prior delivery. Mirrors the mock provider: the
   * persisted transport attempt is read from local storage. No network call,
   * no secret exposure, and the API key is never included in the result.
   */
  inspect(
    idempotencyKey: string,
  ): Record<string, unknown> | null {
    const existing = getOutreachSendByKey(idempotencyKey);
    if (!existing) return null;
    return {
      id: existing.id,
      providerId: "resend",
      status: existing.status,
      idempotencyKey: existing.idempotencyKey,
      leadId: existing.leadId,
      draftId: existing.draftId,
      recipientEmail: existing.recipientEmail,
      messageId: existing.messageId,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    };
  }
}
