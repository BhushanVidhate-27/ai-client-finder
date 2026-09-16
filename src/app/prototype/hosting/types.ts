/**
 * Domain model for the Hosting & Deployment prototype.
 *
 * Scope note: this folder is isolated. It deliberately does NOT import the
 * app-level deployment abstractions in `src/lib/deployment/types.ts` (which
 * describe hosting *agent jobs*, a different concern). The descriptor type here
 * is named `PrototypeDeploymentProvider` so the two can never be confused.
 */

/** Hosting providers the prototype knows about. */
export type ProviderId =
  | "vercel"
  | "netlify"
  | "cloudflare-pages"
  | "custom-vps"
  | "railway"
  | "fly-io"
  | "render";

export type ProviderAvailability = "available" | "coming_soon";

/**
 * Descriptor for the provider picker.
 *
 * Renamed from `HostingProvider` on purpose: the main app already has a
 * `HostingProvider` interface with different semantics, and the prototype must
 * stay isolated from it.
 */
export interface PrototypeDeploymentProvider {
  id: ProviderId;
  name: string;
  /** One-line description shown under the provider name. */
  description: string;
  availability: ProviderAvailability;
  /** What a real integration would need before it can deploy. */
  requirement: string;
  /** Optional short tag, e.g. "Recommended". */
  tag: string | null;
  /** Simulated CLI entry point, shown on the selected card. */
  cliHint: string;
}

export type ConnectionState = "not_connected" | "connected" | "auth_required";

export interface ProviderConnection {
  providerId: ProviderId;
  state: ConnectionState;
  /** Human readable account/workspace label. Never a token. */
  accountLabel: string | null;
  /** Informational only; the prototype never requests or stores scopes. */
  scopes: string[];
  lastCheckedAt: string | null;
}

export type DeploymentStatus =
  | "not_deployed"
  | "preparing"
  | "building"
  | "deploying"
  | "live"
  | "failed"
  | "stopped";

export interface WebsiteInfo {
  businessName: string;
  projectId: string;
  leadId: string;
  campaignId: string;
  /** Current website version produced by the generator. */
  version: number;
  framework: string;
  buildCommand: string;
  outputDirectory: string;
  publicUrl: string | null;
  lastDeployedAt: string | null;
}

export type LogLevel = "command" | "info" | "success" | "warn" | "error" | "auth";

export type LogSource = "build" | "provider" | "control" | "system";

export interface LogEntry {
  id: string;
  /** ISO timestamp, rendered by the logs panel. */
  at: string;
  level: LogLevel;
  source: LogSource;
  text: string;
}

/**
 * One simulated line of provider output.
 *
 * A step can also carry a state transition: `status` moves the deployment
 * lifecycle, `connectionState` moves the provider authentication lifecycle.
 * Nothing here is executed; the line is a string revealed on a timer.
 */
export interface ScriptedStep {
  level: LogLevel;
  source: LogSource;
  text: string;
  /** Delay before this line appears, relative to the previous line. */
  delayMs: number;
  status?: DeploymentStatus;
  connectionState?: ConnectionState;
}

export interface DeploymentRecord {
  id: string;
  version: number;
  providerId: ProviderId;
  status: DeploymentStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  publicUrl: string | null;
  /** Short human explanation, e.g. the failure reason. */
  note: string | null;
  logs: LogEntry[];
}

export type DeploymentMode = "deploy" | "redeploy";

/** What the UI asks a provider adapter to do. */
export interface DeploymentRequest {
  projectId: string;
  version: number;
  providerId: ProviderId;
  mode: DeploymentMode;
}

export interface DeploymentOutcome {
  status: DeploymentStatus;
  publicUrl: string | null;
  note: string | null;
  durationMs: number;
}

/**
 * Demo-only failure injection.
 *
 * `build` / `deploy` / `auth` fail the next deployment (or, for `auth`, the next
 * connect) and are consumed once so Retry succeeds afterwards.
 */
export type FailureMode = "none" | "build" | "deploy" | "auth";
