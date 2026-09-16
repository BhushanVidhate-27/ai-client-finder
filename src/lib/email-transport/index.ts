/**
 * Email Transport (Step 17).
 *
 * Public surface for the email transport layer. The transport service is the
 * ONLY component that invokes an email transport provider; all prior safety
 * decisions (A8 send-safety, A9 orchestrator, A10 transport-safety) MUST have
 * passed before the service is called.
 */

export { transportEmail, EmailTransportError, listRegisteredProviders } from "@/lib/email-transport/service";
export { MockEmailTransportProvider, buildMockMessageId } from "@/lib/email-transport/providers/mock";
export { ResendEmailTransportProvider } from "@/lib/email-transport/providers/resend";
export {
  readEmailTransportConfig,
  isResendConfigured,
  isResendProviderReady,
  getAvailableProviders,
  ENV_RESEND_API_KEY,
  ENV_RESEND_FROM_EMAIL,
} from "@/lib/email-transport/config";
export type {
  EmailTransportRequest,
  EmailTransportOutcome,
  EmailDeliveryResult,
  EmailTransportProvider,
  EmailProviderSummary,
  EmailTransportOptions,
  DeliveryStatus,
  TransportOutcomeStatus,
} from "@/lib/email-transport/types";
