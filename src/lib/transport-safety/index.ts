/**
 * Transport Safety (Agent 10).
 *
 * Public surface for the transport safety module. Everything a consumer needs
 * to run a deterministic pre-transport gate and understand its result.
 */

export {
  evaluateTransportSafety,
  mapTransportDecision,
} from "@/lib/transport-safety/engine";
export { createTransportSafetyAgent } from "@/lib/transport-safety/agent";
export {
  SUPPORTED_TRANSPORT_PROVIDERS,
  type TransportCheck,
  type TransportDecision,
  type SupportedTransportProvider,
  type TransportApprovalStatus,
  type TransportProviderStatus,
  type TransportWebsiteStatus,
  type TransportResult,
  type TransportSafetyInput,
  type TransportSafetyOptions,
} from "@/lib/transport-safety/types";