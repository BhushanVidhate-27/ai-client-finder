"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DeploymentProviderAdapter,
  DeploymentRunPlan,
  ProviderCapabilities,
} from "../provider-contract";
import type {
  DeploymentMode,
  DeploymentOutcome,
  DeploymentRecord,
  DeploymentRequest,
  DeploymentStatus,
  LogEntry,
  LogLevel,
  LogSource,
  ProviderConnection,
  ScriptedStep,
  WebsiteInfo,
} from "../types";
import { deploymentProgress, isActiveStatus } from "./status";

/**
 * Drives one provider adapter for one provider.
 *
 * The hook is mounted per provider (the workspace is keyed by provider id), so
 * switching providers swaps the adapter and the whole view rather than mixing
 * two providers' state. Everything it shows comes from the adapter contract:
 *
 *   load       → getWebsite, getDeploymentHistory, getLogs, getSessionIntro
 *   connect    → connect (simulated handshake) → onConnectionChange
 *   deploy     → deploy/redeploy → streamed steps → reportRunResult
 *   confirm    → getDeploymentStatus (the provider is the source of truth)
 *   stop       → stop → reportRunResult
 *   live site  → getPublicUrl
 *
 * Nothing here executes a command, opens a socket, or stores a credential.
 */

export interface ProviderDeploymentSessionOptions {
  adapter: DeploymentProviderAdapter;
  /** Called whenever the adapter reports a new connection state. */
  onConnectionChange: (connection: ProviderConnection) => void;
  /** Called when a demo-injected failure was consumed, so the UI can reset it. */
  onFailureConsumed: () => void;
}

export interface ProviderDeploymentSession {
  adapterLabel: string;
  providerLabel: string;
  capabilities: ProviderCapabilities;
  isLoading: boolean;
  isConnecting: boolean;
  isRunActive: boolean;
  isStopping: boolean;
  error: string | null;

  website: WebsiteInfo | null;
  deployments: DeploymentRecord[];
  status: DeploymentStatus;
  progress: number;
  /** Most recent version actually serving traffic on this provider. */
  liveRecord: DeploymentRecord | null;

  terminalLines: LogEntry[];
  logs: LogEntry[];
  logsDeploymentId: string | null;
  activeRunDeploymentId: string | null;
  phaseAtFailure: DeploymentStatus | null;

  deploy: (mode: DeploymentMode) => Promise<void>;
  stop: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  viewLogs: (record: DeploymentRecord) => Promise<void>;
  resolvePublicUrl: (deploymentId?: string) => Promise<string | null>;
  clearTerminal: () => void;
}

interface ActiveRun {
  runId: string;
  deploymentId: string;
  version: number;
  startedAt: number;
}

export function useProviderDeploymentSession(
  options: ProviderDeploymentSessionOptions,
): ProviderDeploymentSession {
  const { adapter, onConnectionChange, onFailureConsumed } = options;

  const [website, setWebsite] = useState<WebsiteInfo | null>(null);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [status, setStatus] = useState<DeploymentStatus>("not_deployed");
  const [terminalLines, setTerminalLines] = useState<LogEntry[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsDeploymentId, setLogsDeploymentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [phaseAtFailure, setPhaseAtFailure] = useState<DeploymentStatus | null>(null);

  const disposedRef = useRef(false);
  const playbackGenerationRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const resolversRef = useRef<Set<() => void>>(new Set());
  const activeRecordIdRef = useRef<string | null>(null);
  const logsTargetIdRef = useRef<string | null>(null);
  const streamedRef = useRef<LogEntry[]>([]);
  const lastPhaseRef = useRef<DeploymentStatus | null>(null);
  const activePlanRef = useRef<DeploymentRunPlan | null>(null);
  const lineCounterRef = useRef(0);

  // --- playback plumbing --------------------------------------------------

  const cancelPlayback = useCallback(() => {
    playbackGenerationRef.current += 1;
    timersRef.current.forEach((handle) => window.clearTimeout(handle));
    timersRef.current = [];
    resolversRef.current.forEach((resolve) => resolve());
    resolversRef.current.clear();
  }, []);

  const sleep = useCallback((ms: number) => {
    return new Promise<void>((resolve) => {
      const resolver = () => {
        window.clearTimeout(handle);
        resolversRef.current.delete(resolver);
        resolve();
      };
      const handle = window.setTimeout(resolver, ms);
      timersRef.current.push(handle);
      resolversRef.current.add(resolver);
    });
  }, []);

  const pushLine = useCallback(
    (input: { level: LogLevel; source: LogSource; text: string }, deploymentId?: string) => {
      lineCounterRef.current += 1;
      const entry: LogEntry = {
        id: `line_${adapter.providerId}_${lineCounterRef.current}`,
        at: new Date().toISOString(),
        level: input.level,
        source: input.source,
        text: input.text,
      };

      setTerminalLines((previous) => [...previous, entry]);
      if (deploymentId) {
        streamedRef.current = [...streamedRef.current, entry];
        if (logsTargetIdRef.current === deploymentId) {
          setLogs((previous) => [...previous, entry]);
        }
      }
      return entry;
    },
    [adapter.providerId],
  );

  const applyStep = useCallback(
    async (step: ScriptedStep, deploymentId?: string) => {
      pushLine({ level: step.level, source: step.source, text: step.text }, deploymentId);

      if (step.status) {
        setStatus(step.status);
        if (isActiveStatus(step.status)) lastPhaseRef.current = step.status;
      }

      if (step.connectionState) {
        const snapshot = await adapter.getConnectionState();
        if (snapshot.ok && !disposedRef.current) onConnectionChange(snapshot.data);
      }
    },
    [adapter, onConnectionChange, pushLine],
  );

  /** Reveals scripted lines one at a time. Nothing is executed. */
  const playSteps = useCallback(
    async (
      steps: ScriptedStep[],
      options2: { deploymentId?: string; onComplete: () => Promise<void> | void },
    ) => {
      cancelPlayback();
      const generation = playbackGenerationRef.current;

      for (const step of steps) {
        await sleep(step.delayMs);
        if (disposedRef.current || generation !== playbackGenerationRef.current) return;
        await applyStep(step, options2.deploymentId);
      }

      if (disposedRef.current || generation !== playbackGenerationRef.current) return;
      await options2.onComplete();
    },
    [applyStep, cancelPlayback, sleep],
  );

  // --- reads --------------------------------------------------------------

  const refreshHistory = useCallback(async () => {
    const result = await adapter.getDeploymentHistory("");
    if (disposedRef.current) return;
    if (result.ok) setDeployments(result.data);
    else setError(result.error.message);
  }, [adapter]);

  const refreshWebsite = useCallback(async () => {
    const result = await adapter.getWebsite();
    if (!disposedRef.current && result.ok) setWebsite(result.data);
  }, [adapter]);

  // Initial load for this provider.
  useEffect(() => {
    let cancelled = false;
    // Effect bodies can run twice in development (StrictMode): re-arm the guards.
    disposedRef.current = false;

    const load = async () => {
      try {
        const [websiteResult, historyResult, introResult] = await Promise.all([
          adapter.getWebsite(),
          adapter.getDeploymentHistory(""),
          adapter.getSessionIntro(),
        ]);
        if (cancelled || disposedRef.current) return;

        if (websiteResult.ok) setWebsite(websiteResult.data);
        else setError(websiteResult.error.message);

        const records = historyResult.ok ? historyResult.data : [];
        if (historyResult.ok) setDeployments(records);
        else setError(historyResult.error.message);

        const latest = records[0] ?? null;
        setStatus(latest ? latest.status : "not_deployed");
        setTerminalLines(introResult.ok ? introResult.data : []);

        if (latest) {
          logsTargetIdRef.current = latest.id;
          setLogsDeploymentId(latest.id);
          const logsResult = await adapter.getLogs(latest.id);
          if (!cancelled && !disposedRef.current && logsResult.ok) setLogs(logsResult.data);
        }
      } catch (caughtError) {
        if (!cancelled && !disposedRef.current) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "Could not load data from the provider adapter.",
          );
        }
      } finally {
        if (!cancelled && !disposedRef.current) setIsLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
      disposedRef.current = true;
      cancelPlayback();
    };
  }, [adapter, cancelPlayback]);

  // --- run completion -----------------------------------------------------

  const finishRun = useCallback(
    async (run: { runId: string; deploymentId: string }, outcome: DeploymentOutcome) => {
      try {
        await adapter.reportRunResult(run.runId, { outcome, logs: streamedRef.current });

        // Ask the provider where the run actually landed.
        const snapshot = await adapter.getDeploymentStatus(run.runId);
        const finalOutcome: DeploymentOutcome =
          snapshot.ok
            ? {
                status: snapshot.data.status,
                publicUrl: snapshot.data.publicUrl,
                note: snapshot.data.note,
                durationMs: outcome.durationMs,
              }
            : outcome;

        if (disposedRef.current) return;
        setStatus(finalOutcome.status);
        if (finalOutcome.status === "failed" || finalOutcome.status === "stopped") {
          setPhaseAtFailure(lastPhaseRef.current ?? "building");
        }

        await refreshHistory();
        await refreshWebsite();
      } catch (caughtError) {
        if (!disposedRef.current) {
          setError(
            caughtError instanceof Error ? caughtError.message : "The simulated run did not finish.",
          );
        }
      } finally {
        if (!disposedRef.current) {
          activeRecordIdRef.current = null;
          activePlanRef.current = null;
          setActiveRun(null);
          setIsStopping(false);
        }
      }
    },
    [adapter, refreshHistory, refreshWebsite],
  );

  // --- operations ---------------------------------------------------------

  const deploy = useCallback(
    async (mode: DeploymentMode) => {
      if (!website) return;

      setError(null);
      streamedRef.current = [];
      lastPhaseRef.current = null;
      setPhaseAtFailure(null);

      const request: DeploymentRequest = {
        projectId: website.projectId,
        version: website.version,
        providerId: adapter.providerId,
        mode,
      };
      const startedAt = Date.now();

      try {
        const planResult =
          mode === "redeploy" ? await adapter.redeploy(request) : await adapter.deploy(request);

        if (!planResult.ok) {
          if (!disposedRef.current) setError(planResult.error.message);
          return;
        }

        const plan = planResult.data;
        if (plan.injectedFailure) onFailureConsumed();

        activeRecordIdRef.current = plan.deploymentId;
        activePlanRef.current = plan;
        logsTargetIdRef.current = plan.deploymentId;
        setLogsDeploymentId(plan.deploymentId);
        setLogs([]);
        setIsStopping(false);
        setActiveRun({
          runId: plan.runId,
          deploymentId: plan.deploymentId,
          version: plan.request.version,
          startedAt,
        });
        setStatus(plan.steps[0]?.status ?? "preparing");

        await refreshHistory();

        await playSteps(plan.steps, {
          deploymentId: plan.deploymentId,
          onComplete: async () => {
            await finishRun(plan, {
              ...plan.expectedOutcome,
              durationMs: Date.now() - startedAt,
            });
          },
        });
      } catch (caughtError) {
        if (!disposedRef.current) {
          setError(caughtError instanceof Error ? caughtError.message : "Deploy could not start.");
        }
      }
    },
    [adapter, finishRun, onFailureConsumed, playSteps, refreshHistory, website],
  );

  const stop = useCallback(async () => {
    const run = activeRun;
    const plan = activePlanRef.current;
    if (!run || !plan || isStopping) return;

    setIsStopping(true);
    const elapsed = Date.now() - run.startedAt;

    await playSteps(plan.stopSteps, {
      deploymentId: plan.deploymentId,
      onComplete: async () => {
        const stopResult = await adapter.stop(plan.runId, {
          logs: streamedRef.current,
          durationMs: elapsed,
        });

        if (!stopResult.ok) {
          // e.g. this adapter cannot cancel (ProviderCapabilities.canStop = false).
          pushLine(
            { level: "error", source: "provider", text: `✗ ${stopResult.error.message}` },
            plan.deploymentId,
          );
          await finishRun(plan, {
            ...plan.expectedOutcome,
            durationMs: Date.now() - run.startedAt,
          });
          return;
        }

        const outcome = stopResult.data;
        pushLine(
          {
            level: "warn",
            source: "control",
            text: `✗ Deployment stopped: ${outcome.note ?? "stopped by you."}`,
          },
          plan.deploymentId,
        );
        await finishRun(plan, outcome);
      },
    });
  }, [activeRun, adapter, finishRun, isStopping, playSteps, pushLine]);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    try {
      const result = await adapter.connect();
      if (!result.ok) {
        if (!disposedRef.current) setError(result.error.message);
        return;
      }

      const handshake = result.data;
      if (!handshake.succeeded) onFailureConsumed();
      onConnectionChange(handshake.pending);

      await playSteps(handshake.steps, {
        onComplete: () => {
          onConnectionChange(handshake.result);
          if (!handshake.succeeded) {
            setError(
              `Authorization failed for ${adapter.providerLabel} (simulated). Try connecting again.`,
            );
          }
        },
      });
    } catch (caughtError) {
      if (!disposedRef.current) {
        setError(caughtError instanceof Error ? caughtError.message : "Connect failed.");
      }
    } finally {
      if (!disposedRef.current) setIsConnecting(false);
    }
  }, [adapter, onConnectionChange, onFailureConsumed, playSteps]);

  const disconnect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    try {
      const result = await adapter.disconnect();
      if (!result.ok) {
        if (!disposedRef.current) setError(result.error.message);
        return;
      }

      await playSteps(result.data.steps, {
        onComplete: () => onConnectionChange(result.data.connection),
      });
    } catch (caughtError) {
      if (!disposedRef.current) {
        setError(caughtError instanceof Error ? caughtError.message : "Disconnect failed.");
      }
    } finally {
      if (!disposedRef.current) setIsConnecting(false);
    }
  }, [adapter, onConnectionChange, playSteps]);

  const viewLogs = useCallback(
    async (record: DeploymentRecord) => {
      logsTargetIdRef.current = record.id;
      setLogsDeploymentId(record.id);

      // While a run streams, keep following it instead of replacing the view.
      if (activeRecordIdRef.current === record.id) return;

      const result = await adapter.getLogs(record.id);
      if (disposedRef.current) return;
      if (result.ok) setLogs(result.data);
      else setError(result.error.message);
    },
    [adapter],
  );

  const resolvePublicUrl = useCallback(
    async (deploymentId?: string) => {
      const result = await adapter.getPublicUrl(deploymentId);
      return result.ok ? result.data : null;
    },
    [adapter],
  );

  const clearTerminal = useCallback(() => {
    setTerminalLines([]);
  }, []);

  const liveRecord = useMemo(
    () => deployments.find((record) => record.status === "live" && record.publicUrl) ?? null,
    [deployments],
  );

  return {
    adapterLabel: adapter.adapterLabel,
    providerLabel: adapter.providerLabel,
    capabilities: adapter.capabilities,
    isLoading,
    isConnecting,
    isRunActive: activeRun !== null,
    isStopping,
    error,
    website,
    deployments,
    status,
    progress: deploymentProgress(status),
    liveRecord,
    terminalLines,
    logs,
    logsDeploymentId,
    activeRunDeploymentId: activeRun?.deploymentId ?? null,
    phaseAtFailure,
    deploy,
    stop,
    connect,
    disconnect,
    viewLogs,
    resolvePublicUrl,
    clearTerminal,
  };
}
