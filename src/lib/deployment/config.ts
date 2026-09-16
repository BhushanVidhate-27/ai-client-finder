/**
 * Hosting provider configuration (Step 13).
 *
 * Credentials are read from server-side environment variables only, at call
 * time (so tests can flip them without re-importing modules). Nothing here is
 * ever exposed to the client, written into website source, packaged into an
 * artifact, or logged.
 */

export const ENV_VERCEL_TOKEN = "VERCEL_TOKEN";
export const ENV_NETLIFY_TOKEN = "NETLIFY_TOKEN";
export const ENV_CLOUDFLARE_API_TOKEN = "CLOUDFLARE_API_TOKEN";
export const ENV_CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";

/** When enabled, registers the clearly-labelled mock provider at runtime. */
export const ENV_MOCK_DEPLOYMENTS = "MOCK_DEPLOYMENTS";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export interface DeploymentConfig {
  vercelToken?: string;
  netlifyToken?: string;
  cloudflareToken?: string;
  cloudflareAccountId?: string;
  mockEnabled: boolean;
}

export function readDeploymentConfig(overrides?: Partial<DeploymentConfig>): DeploymentConfig {
  return {
    vercelToken: overrides?.vercelToken ?? env(ENV_VERCEL_TOKEN),
    netlifyToken: overrides?.netlifyToken ?? env(ENV_NETLIFY_TOKEN),
    cloudflareToken: overrides?.cloudflareToken ?? env(ENV_CLOUDFLARE_API_TOKEN),
    cloudflareAccountId:
      overrides?.cloudflareAccountId ?? env(ENV_CLOUDFLARE_ACCOUNT_ID),
    mockEnabled:
      overrides?.mockEnabled ??
      (env(ENV_MOCK_DEPLOYMENTS) === "1" ||
        env(ENV_MOCK_DEPLOYMENTS) === "true"),
  };
}

export function isProviderConfigured(
  provider: string,
  config: DeploymentConfig,
): boolean {
  switch (provider) {
    case "vercel":
      return Boolean(config.vercelToken);
    case "netlify":
      return Boolean(config.netlifyToken);
    case "cloudflare":
      return Boolean(config.cloudflareToken && config.cloudflareAccountId);
    case "mock":
      return config.mockEnabled;
    default:
      return false;
  }
}