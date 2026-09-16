import type {
  DeploymentProviderId,
  ProviderConnectionResult,
  ProviderCancelResult,
  ProviderDeploymentHandle,
  ProviderDeploymentRequest,
  ProviderDeploymentSnapshot,
} from "@/lib/deployment/types";

/**
 * Hosting provider adapter contract (Step 13).
 *
 * One implementation per hosting provider. The rest of the app depends only on
 * this interface: swapping a real provider for the mock (or adding a provider)
 * means implementing this and registering it.
 *
 * Providers are never called with arbitrary client-supplied URLs or paths —
 * endpoints are fixed in trusted adapter code/configuration, and the artifact
 * handed to `deploy` is the server-verified, deterministically packaged version
 * source. Credentials are read server-side and never flow through the wire
 * types. Every method throws `DeploymentProviderError` (or a subclass) with a
 * safe message rather than leaking internals.
 */
export interface HostingProviderAdapter {
  readonly providerId: DeploymentProviderId;
  readonly providerLabel: string;
  /** True for the dev/test mock provider. Never surfaces as a real deploy. */
  readonly isMock: boolean;
  /** Provider supports cancelling an in-flight run. */
  readonly supportsCancel: boolean;

  /** Validates server-side provider connectivity without exposing secrets. */
  validateConnection(): Promise<ProviderConnectionResult>;

  /** Starts deployment of the verified artifact. */
  deploy(request: ProviderDeploymentRequest): Promise<ProviderDeploymentHandle>;

  /** Polls the provider for the current run status. */
  getDeploymentStatus(
    handle: ProviderDeploymentHandle,
  ): Promise<ProviderDeploymentSnapshot>;

  /** Attempts to cancel an in-flight run, when supported. */
  cancelDeployment(
    handle: ProviderDeploymentHandle | null,
  ): Promise<ProviderCancelResult>;

  /** Returns the public deployment URL once the provider has assigned one. */
  getDeploymentUrl(handle: ProviderDeploymentHandle): Promise<string | null>;
}