/**
 * Email Transport — provider configuration (Resend).
 *
 * Credentials are read from server-side environment variables only, at call
 * time (so tests can flip them without re-importing modules). Nothing here is
 * ever exposed to the client, written into website source, packaged into an
 * artifact, or logged.
 */

export const ENV_RESEND_API_KEY = "RESEND_API_KEY";
export const ENV_RESEND_FROM_EMAIL = "RESEND_FROM_EMAIL";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export interface EmailTransportProviderConfig {
  resendApiKey?: string;
  resendFromEmail?: string;
  mockEnabled: boolean;
}

export function readEmailTransportConfig(
  overrides?: Partial<EmailTransportProviderConfig>,
): EmailTransportProviderConfig {
  return {
    resendApiKey: overrides?.resendApiKey ?? env(ENV_RESEND_API_KEY),
    resendFromEmail: overrides?.resendFromEmail ?? env(ENV_RESEND_FROM_EMAIL),
    mockEnabled: overrides?.mockEnabled ?? true,
  };
}

export function isResendConfigured(
  config?: EmailTransportProviderConfig,
): boolean {
  const cfg = config ?? readEmailTransportConfig();
  return Boolean(cfg.resendApiKey);
}

/**
 * True only when the Resend adapter has everything it needs to send:
 * the API key AND the server-configured from address. Used by Agent 10 so a
 * provider can only be marked "configured" when a real send is possible.
 */
export function isResendProviderReady(
  config?: EmailTransportProviderConfig,
): boolean {
  const cfg = config ?? readEmailTransportConfig();
  return Boolean(cfg.resendApiKey && cfg.resendFromEmail);
}

/**
 * Safe summary of which providers are available. No secrets are included.
 */
export function getAvailableProviders(
  config?: EmailTransportProviderConfig,
): { mock: boolean; resend: boolean } {
  const cfg = config ?? readEmailTransportConfig();
  return {
    mock: cfg.mockEnabled,
    resend: isResendConfigured(cfg),
  };
}
