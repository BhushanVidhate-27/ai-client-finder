/**
 * Deployment errors (Step 13).
 *
 * Every error the deployment system raises maps to a safe, secret-free
 * message. Provider adapter errors never include tokens, response bodies, or
 * server paths — the adapters surface a `safeMessage` through these types and
 * the underlying cause is never logged or returned to a client.
 */

export class DeploymentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DeploymentError";
    this.code = code;
  }
}

/** Provider has no credentials configured; nothing may be deployed. */
export class DeploymentNotConfiguredError extends DeploymentError {
  constructor(provider: string) {
    super(
      "NOT_CONFIGURED",
      `Deployment provider "${provider}" is not configured. Add its credentials to the server environment and try again.`,
    );
    this.name = "DeploymentNotConfiguredError";
  }
}

/** The version/workspace/hash failed server-side verification. */
export class DeploymentIneligibleError extends DeploymentError {
  constructor(reason: string) {
    super("INELIGIBLE", reason);
    this.name = "DeploymentIneligibleError";
  }
}

/** Another deployment is already active for the same project. */
export class DeploymentConflictError extends DeploymentError {
  constructor(message: string) {
    super("CONFLICT", message);
    this.name = "DeploymentConflictError";
  }
}

/** Provider rejected or failed the deployment. `safeMessage` is client-safe. */
export class DeploymentProviderError extends DeploymentError {
  constructor(provider: string, safeMessage: string) {
    super("PROVIDER_ERROR", `${provider}: ${safeMessage}`);
    this.name = "DeploymentProviderError";
  }
}

/** The provider never reached a terminal state within the poll budget. */
export class DeploymentTimeoutError extends DeploymentError {
  constructor(provider: string) {
    super(
      "TIMEOUT",
      `${provider}: deployment did not reach a terminal state in time and was marked failed.`,
    );
    this.name = "DeploymentTimeoutError";
  }
}

/** The requested deployment does not exist. */
export class DeploymentNotFoundError extends DeploymentError {
  constructor(deploymentId: string) {
    super("NOT_FOUND", `Deployment "${deploymentId}" not found.`);
    this.name = "DeploymentNotFoundError";
  }
}

/** Same as not-configured but for the mock provider being disabled. */
export class MockProviderDisabledError extends DeploymentNotConfiguredError {
  constructor() {
    super("mock");
    this.name = "MockProviderDisabledError";
  }
}