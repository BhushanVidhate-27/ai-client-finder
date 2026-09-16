/**
 * Mock Email Transport Provider (Step 17).
 *
 * A deterministic simulated delivery provider. It performs ZERO network calls,
 * never contacts any external service, and never sends a real email. The
 * message identifier is a deterministic function of the idempotency key, so
 * the same request always produces the same simulated delivery — repeated
 * evaluation is byte-identical.
 *
 * The provider stamps every result with provider "mock" and a delivery status
 * that can never be confused with a real provider's outcome.
 */

import { createHash } from "node:crypto";
import { getOutreachSendByKey } from "@/lib/data/outreach";
import type {
  EmailDeliveryResult,
  EmailTransportProvider,
  EmailTransportRequest,
} from "@/lib/email-transport/types";

/** Deterministic simulated message id: a sha-256 of the idempotency key. */
export function buildMockMessageId(idempotencyKey: string): string {
  return `mock_${createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * The deterministic mock provider. Registered as the ONLY email transport
 * provider. Real providers are intentionally not registered anywhere.
 */
export class MockEmailTransportProvider implements EmailTransportProvider {
  readonly providerId = "mock";
  readonly providerLabel = "Mock";
  readonly isMock = true;

  async send(request: EmailTransportRequest): Promise<EmailDeliveryResult> {
    // No network. No external API. No actual email. The simulated delivery is
    // derived entirely from the validated request.
    return {
      messageId: buildMockMessageId(request.idempotencyKey),
      providerId: "mock",
      status: "simulated",
      timestamp: new Date().toISOString(),
      idempotencyKey: request.idempotencyKey,
    };
  }

  inspect(idempotencyKey: string): Record<string, unknown> | null {
    const existing = getOutreachSendByKey(idempotencyKey);
    if (!existing) return null;
    return {
      id: existing.id,
      providerId: "mock",
      status: existing.status,
      idempotencyKey: existing.idempotencyKey,
      leadId: existing.leadId,
      draftId: existing.draftId,
      recipientEmail: existing.recipientEmail,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    };
  }
}