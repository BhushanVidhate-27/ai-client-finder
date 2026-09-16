import type {
  DeploymentOutcome,
  FailureMode,
  LogEntry,
  ScriptedStep,
} from "../../types";

/**
 * Scripted lifecycle narration.
 *
 * Every "command", log line, and progress message below is a string. Nothing in
 * this module spawns a process, opens a socket, or contacts a provider: the
 * session hook reveals these lines one at a time on a timer.
 *
 * Each provider supplies a `ProviderVoice` so the same lifecycle reads like that
 * provider's CLI, which is what makes provider switching visible in the UI.
 *
 * Status transitions deliberately stop short of the final state in two places:
 * the stop narration ends at "waiting for confirmation", and the session only
 * marks a run stopped once the adapter has confirmed it. A provider that cannot
 * cancel (see `ProviderCapabilities.canStop`) is then handled honestly.
 */

export interface ProviderVoice {
  /** Provider display name, e.g. "Vercel". */
  label: string;
  /** CLI binary shown in simulated commands, e.g. "vercel". */
  binary: string;
  /** Full simulated deploy command. */
  deployCommand: string;
  /** Simulated CLI version banner. */
  cliVersion: string;
  /** What the upload step is called for this provider. */
  uploadLabel: string;
  /** Simulated login command used by the connect handshake. */
  authCommand: string;
  /** Number of static routes, used in the simulated build output. */
  routeCount: number;
}

export interface DeployScript {
  steps: ScriptedStep[];
  durationMs: number;
  expectedOutcome: DeploymentOutcome;
}

export function scriptDurationMs(steps: ScriptedStep[]): number {
  return steps.reduce((total, step) => total + step.delayMs, 0);
}

/** Turns scripted steps into timestamped log lines. */
export function logsFromSteps(steps: ScriptedStep[], startedAt: number): LogEntry[] {
  let elapsed = 0;
  return steps.map((step, index) => {
    elapsed += step.delayMs;
    return {
      id: `log_${startedAt}_${index}`,
      at: new Date(startedAt + elapsed).toISOString(),
      level: step.level,
      source: step.source,
      text: step.text,
    };
  });
}

function buildPhase(voice: ProviderVoice): ScriptedStep[] {
  return [
    { level: "command", source: "control", text: "$ npm run build", delayMs: 420, status: "preparing" },
    { level: "info", source: "build", text: "> next build", delayMs: 360 },
    {
      level: "info",
      source: "build",
      text: "Creating an optimized production build...",
      delayMs: 700,
      status: "building",
    },
    { level: "info", source: "build", text: "✓ Compiled successfully in 4.2s", delayMs: 1100 },
    {
      level: "info",
      source: "build",
      text: `Collecting page data for ${voice.routeCount} routes...`,
      delayMs: 650,
    },
    { level: "info", source: "build", text: "Exporting static output to ./out", delayMs: 600 },
  ];
}

function deployPhaseIntro(voice: ProviderVoice): ScriptedStep[] {
  return [
    {
      level: "command",
      source: "control",
      text: `$ ${voice.deployCommand}`,
      delayMs: 450,
      status: "deploying",
    },
    { level: "info", source: "provider", text: voice.cliVersion, delayMs: 500 },
    {
      level: "info",
      source: "provider",
      text: "Authenticating with the stored provider session...",
      delayMs: 800,
    },
  ];
}

/**
 * Steps that play when the user presses Stop.
 *
 * The last line asks the provider to confirm; the session appends the provider's
 * answer and owns the final `stopped` transition.
 */
export function buildStopSteps(voice: ProviderVoice): ScriptedStep[] {
  return [
    { level: "warn", source: "control", text: "■ Stop requested by you", delayMs: 250 },
    {
      level: "info",
      source: "provider",
      text: `Sending cancellation to ${voice.binary}...`,
      delayMs: 700,
    },
    { level: "info", source: "provider", text: "Releasing build resources...", delayMs: 600 },
    {
      level: "info",
      source: "provider",
      text: "Discarding draft artifacts (the live version is untouched).",
      delayMs: 700,
    },
    {
      level: "info",
      source: "provider",
      text: `> Waiting for ${voice.label} to confirm the cancellation...`,
      delayMs: 700,
    },
  ];
}

/**
 * Builds one full deployment script.
 *
 * `failure` is the demo injection: "none" is the happy path, the others stop at
 * the matching phase. Only "auth" also moves the connection state.
 */
export function buildDeployScript(input: {
  voice: ProviderVoice;
  providerLabel: string;
  version: number;
  url: string;
  failure: FailureMode;
}): DeployScript {
  const { voice, providerLabel, version, url, failure } = input;
  const build = buildPhase(voice);

  if (failure === "build") {
    const steps: ScriptedStep[] = [
      ...build,
      { level: "error", source: "build", text: "Error: Failed to compile.", delayMs: 800 },
      {
        level: "error",
        source: "build",
        text: "src/app/page.tsx:12:5 — Type error: Property 'hero' does not exist on type 'SiteContent'.",
        delayMs: 700,
      },
      {
        level: "warn",
        source: "build",
        text: "Build exited with code 1. Nothing was published.",
        delayMs: 600,
      },
    ];
    return {
      steps,
      durationMs: scriptDurationMs(steps),
      expectedOutcome: {
        status: "failed",
        publicUrl: null,
        note: `Build failed for v${version} (exit code 1). The live version was left untouched.`,
        durationMs: scriptDurationMs(steps),
      },
    };
  }

  if (failure === "auth") {
    const steps: ScriptedStep[] = [
      ...build,
      { level: "success", source: "build", text: "✓ Build successful", delayMs: 500 },
      ...deployPhaseIntro(voice),
      {
        level: "warn",
        source: "provider",
        text: "Authentication required",
        delayMs: 700,
        connectionState: "auth_required",
      },
      { level: "auth", source: "provider", text: "> Waiting for authentication...", delayMs: 1200 },
      {
        level: "error",
        source: "provider",
        text: `✗ Deployment aborted: the ${providerLabel} session expired. Reconnect the provider, then retry.`,
        delayMs: 800,
        connectionState: "auth_required",
      },
    ];
    return {
      steps,
      durationMs: scriptDurationMs(steps),
      expectedOutcome: {
        status: "failed",
        publicUrl: null,
        note: "Authentication required: the provider session expired.",
        durationMs: scriptDurationMs(steps),
      },
    };
  }

  if (failure === "deploy") {
    const steps: ScriptedStep[] = [
      ...build,
      { level: "success", source: "build", text: "✓ Build successful", delayMs: 500 },
      ...deployPhaseIntro(voice),
      { level: "info", source: "provider", text: "Retrieving project settings...", delayMs: 700 },
      {
        level: "info",
        source: "provider",
        text: `${voice.uploadLabel} (18 files, 412 KB)...`,
        delayMs: 900,
      },
      {
        level: "error",
        source: "provider",
        text: `${voice.binary}: the provider rejected the upload (HTTP 500). No alias was assigned.`,
        delayMs: 900,
      },
      {
        level: "warn",
        source: "provider",
        text: "The previously live version is unchanged.",
        delayMs: 600,
      },
    ];
    return {
      steps,
      durationMs: scriptDurationMs(steps),
      expectedOutcome: {
        status: "failed",
        publicUrl: null,
        note: `${providerLabel} rejected the upload (HTTP 500). Nothing was published.`,
        durationMs: scriptDurationMs(steps),
      },
    };
  }

  const steps: ScriptedStep[] = [
    ...build,
    { level: "success", source: "build", text: "✓ Build successful", delayMs: 500 },
    ...deployPhaseIntro(voice),
    { level: "info", source: "provider", text: "Retrieving project settings...", delayMs: 700 },
    {
      level: "info",
      source: "provider",
      text: `${voice.uploadLabel} (18 files, 412 KB)...`,
      delayMs: 900,
    },
    { level: "success", source: "provider", text: "✓ Files uploaded", delayMs: 700 },
    { level: "info", source: "provider", text: `Assigning alias ${url}...`, delayMs: 900 },
    {
      level: "success",
      source: "provider",
      text: `✓ Deployment ready on ${providerLabel}`,
      delayMs: 800,
      status: "live",
    },
    { level: "info", source: "provider", text: `> Public URL: ${url}`, delayMs: 600 },
  ];

  return {
    steps,
    durationMs: scriptDurationMs(steps),
    expectedOutcome: {
      status: "live",
      publicUrl: url,
      note: `${providerLabel} is serving v${version}.`,
      durationMs: scriptDurationMs(steps),
    },
  };
}

/** Script for a run that was halted mid-build, used for seeded history. */
export function buildStoppedScript(input: {
  voice: ProviderVoice;
  providerLabel: string;
  version: number;
}): DeployScript {
  const steps: ScriptedStep[] = [
    ...buildPhase(input.voice).slice(0, 4),
    ...buildStopSteps(input.voice),
  ];
  return {
    steps,
    durationMs: scriptDurationMs(steps),
    expectedOutcome: {
      status: "stopped",
      publicUrl: null,
      note: "Stopped by you. The previously live version is still online.",
      durationMs: scriptDurationMs(steps),
    },
  };
}

/**
 * Simulated authentication handshake.
 *
 * Passes through the "authentication required" state on purpose: that is the
 * transition the UI needs to be designed against.
 */
export function buildConnectSteps(input: {
  voice: ProviderVoice;
  providerLabel: string;
  accountLabel: string;
  succeeded: boolean;
}): ScriptedStep[] {
  const opening: ScriptedStep[] = [
    {
      level: "command",
      source: "control",
      text: `$ ${input.voice.authCommand}`,
      delayMs: 400,
      connectionState: "auth_required",
    },
    {
      level: "info",
      source: "provider",
      text: `Opening ${input.providerLabel} authorization (simulated)...`,
      delayMs: 600,
    },
    {
      level: "warn",
      source: "provider",
      text: "Authentication required — approve the request in the provider dashboard. No browser window opens here.",
      delayMs: 700,
      connectionState: "auth_required",
    },
    { level: "auth", source: "provider", text: "> Waiting for authentication...", delayMs: 1100 },
  ];

  if (!input.succeeded) {
    return [
      ...opening,
      {
        level: "error",
        source: "provider",
        text: "✗ Authorization failed or expired (simulated). Try again.",
        delayMs: 800,
        connectionState: "auth_required",
      },
    ];
  }

  return [
    ...opening,
    {
      level: "info",
      source: "provider",
      text: "Received an authorization code (simulated). Exchanging it for a session...",
      delayMs: 900,
    },
    {
      level: "success",
      source: "provider",
      text: `✓ Connected as ${input.accountLabel}`,
      delayMs: 700,
      connectionState: "connected",
    },
    {
      level: "info",
      source: "system",
      text: "# No token was stored: this prototype keeps the connection in memory for this page only.",
      delayMs: 500,
    },
  ];
}

export function buildDisconnectSteps(input: {
  voice: ProviderVoice;
  providerLabel: string;
}): ScriptedStep[] {
  return [
    {
      level: "command",
      source: "control",
      text: `$ ${input.voice.binary} logout`,
      delayMs: 350,
    },
    {
      level: "info",
      source: "provider",
      text: "Revoking the simulated session...",
      delayMs: 600,
    },
    {
      level: "info",
      source: "system",
      text: "# The account label is forgotten. There was no real credential to delete.",
      delayMs: 500,
    },
    {
      level: "warn",
      source: "provider",
      text: `• Disconnected from ${input.providerLabel}.`,
      delayMs: 500,
      connectionState: "not_connected",
    },
  ];
}

/** Opening console lines for a provider session. */
export function buildSessionIntro(input: {
  voice: ProviderVoice;
  providerLabel: string;
  adapterLabel: string;
  connectionState: string;
  existingDeployments: number;
}): LogEntry[] {
  const now = Date.now();
  const lines = [
    `# ${input.adapterLabel} — simulated provider. No command is executed and no API is contacted.`,
    `# Provider: ${input.providerLabel} · connection: ${input.connectionState} · history: ${input.existingDeployments} run(s).`,
    "# Press Deploy to stream a simulated build and upload, or Connect to run the simulated authorization handshake.",
  ];

  return lines.map((text, index) => ({
    id: `intro_${now}_${index}`,
    at: new Date(now - (lines.length - index) * 500).toISOString(),
    level: "info" as const,
    source: "system" as const,
    text,
  }));
}
