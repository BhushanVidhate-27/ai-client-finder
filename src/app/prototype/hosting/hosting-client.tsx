"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  createSimulationHarness,
  type DeploymentProviderAdapter,
  type ProviderAdapterRegistry,
} from "./provider-contract";
import type {
  FailureMode,
  PrototypeDeploymentProvider,
  ProviderConnection,
  ProviderId,
} from "./types";
import { createPrototypeProviders } from "./lib/providers";
import { useProviderDeploymentSession } from "./lib/use-provider-deployment-session";
import { formatVersion } from "./lib/format";
import { Panel } from "./components/panel";
import { PrototypeBanner } from "./components/prototype-banner";
import { PrototypeControls } from "./components/prototype-controls";
import { DeploymentStatusBadge } from "./components/status-badge";
import { ProviderSelector, type ProviderAdapterInfo } from "./components/provider-selector";
import { ConnectionStateCard } from "./components/connection-state";
import { WebsiteInfoCard } from "./components/website-info-card";
import { DeploymentStatusCard } from "./components/deployment-status-card";
import { DeploymentControls, StickyDeploymentBar } from "./components/deployment-controls";
import { TerminalPanel } from "./components/terminal-panel";
import { DeploymentLogsPanel } from "./components/logs-panel";
import { DeploymentHistory } from "./components/deployment-history";
import { ConfirmDialog } from "./components/confirm-dialog";

/**
 * Hosting & Deployment prototype.
 *
 * Structure:
 *   HostingPrototype  — owns the adapter registry, the demo failure injector, and
 *                       the provider connection snapshots for the picker.
 *   ProviderWorkspace — one provider at a time, keyed by provider id. Remounting
 *                       on switch means every provider's view state is separate
 *                       and the same components serve every adapter unchanged.
 *
 * Everything the workspace renders comes through `DeploymentProviderAdapter`, so
 * replacing a mock adapter with a real integration requires no UI changes.
 */

interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  tone: "danger" | "primary";
  details?: ReactNode;
  onConfirm: () => void;
}

export default function HostingPrototype() {
  const [harness] = useState(createSimulationHarness);
  const [failureMode, setFailureMode] = useState<FailureMode>("none");
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [registry, setRegistry] = useState<ProviderAdapterRegistry>(() =>
    createPrototypeProviders({ harness }),
  );
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<ProviderId>("vercel");

  // Connection snapshots for every adapter, so the picker can show all of them.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const snapshots = await Promise.all(
        registry.listAdapters().map((adapter) => adapter.getConnectionState()),
      );
      if (cancelled) return;
      setConnections(snapshots.flatMap((snapshot) => (snapshot.ok ? [snapshot.data] : [])));
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [registry]);

  const handleConnectionChange = useCallback((connection: ProviderConnection) => {
    setConnections((previous) => {
      const known = previous.some((entry) => entry.providerId === connection.providerId);
      return known
        ? previous.map((entry) =>
            entry.providerId === connection.providerId ? connection : entry,
          )
        : [...previous, connection];
    });
  }, []);

  const handleArmFailure = useCallback(
    (mode: FailureMode) => {
      harness.arm(mode);
      setFailureMode(mode);
    },
    [harness],
  );

  // Fired once an adapter has consumed the injection.
  const handleFailureConsumed = useCallback(() => {
    setFailureMode(harness.current());
  }, [harness]);

  const handleReset = useCallback(() => {
    harness.arm("none");
    setFailureMode("none");
    setConnections([]);
    setRegistry(createPrototypeProviders({ harness }));
    setSessionEpoch((epoch) => epoch + 1);
  }, [harness]);

  const providers = registry.listProviders();
  const adapterInfo: ProviderAdapterInfo[] = useMemo(
    () =>
      registry.listAdapters().map((adapter) => ({
        providerId: adapter.providerId,
        adapterLabel: adapter.adapterLabel,
        capabilities: adapter.capabilities,
      })),
    [registry],
  );

  const activeAdapter = registry.getAdapter(activeProviderId);
  const activeConnection =
    connections.find((entry) => entry.providerId === activeProviderId) ?? null;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-32 pt-6 sm:px-6 lg:pb-12 lg:pt-10">
      <div className="flex flex-col gap-6 lg:gap-8">
        <PrototypeBanner />

        <PrototypeControls
          failureMode={failureMode}
          onArmFailure={handleArmFailure}
          onReset={handleReset}
        />

        {activeAdapter ? (
          <ProviderWorkspace
            key={`${activeProviderId}:${sessionEpoch}`}
            adapter={activeAdapter}
            providers={providers}
            adapterInfo={adapterInfo}
            connections={connections}
            activeProviderId={activeProviderId}
            activeConnection={activeConnection}
            failureMode={failureMode}
            onSelectProvider={setActiveProviderId}
            onConnectionChange={handleConnectionChange}
            onFailureConsumed={handleFailureConsumed}
          />
        ) : (
          <p className="rounded-xl bg-white px-3 py-3 text-xs text-gray-500 ring-1 ring-gray-200 ring-inset">
            {activeProviderId} has no adapter yet. Pick another provider above.
          </p>
        )}
      </div>
    </div>
  );
}

interface ProviderWorkspaceProps {
  adapter: DeploymentProviderAdapter;
  providers: PrototypeDeploymentProvider[];
  adapterInfo: ProviderAdapterInfo[];
  connections: ProviderConnection[];
  activeProviderId: ProviderId;
  activeConnection: ProviderConnection | null;
  failureMode: FailureMode;
  onSelectProvider: (providerId: ProviderId) => void;
  onConnectionChange: (connection: ProviderConnection) => void;
  onFailureConsumed: () => void;
}

function ProviderWorkspace({
  adapter,
  providers,
  adapterInfo,
  connections,
  activeProviderId,
  activeConnection,
  failureMode,
  onSelectProvider,
  onConnectionChange,
  onFailureConsumed,
}: ProviderWorkspaceProps) {
  const session = useProviderDeploymentSession({ adapter, onConnectionChange, onFailureConsumed });
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const providerLabelFor = useCallback(
    (providerId: ProviderId) =>
      providers.find((provider) => provider.id === providerId)?.name ?? providerId,
    [providers],
  );

  const blockedReason = useMemo(() => {
    if (session.isLoading) return "Loading the simulated website data from the adapter…";
    if (!session.website) return "Website details are unavailable.";
    if (!session.capabilities.canDeploy) {
      return `The ${session.providerLabel} adapter cannot deploy.`;
    }
    if (activeConnection?.state !== "connected") {
      return `Connect ${session.providerLabel} to unblock deployment (simulated, no credentials involved).`;
    }
    if (session.isRunActive) {
      return "A run is in progress. Stop it before starting another deployment.";
    }
    return null;
  }, [
    activeConnection?.state,
    session.capabilities.canDeploy,
    session.isLoading,
    session.isRunActive,
    session.providerLabel,
    session.website,
  ]);

  const isReady = blockedReason === null;
  const version = session.website?.version ?? 1;
  const liveUrl = session.liveRecord?.publicUrl ?? session.website?.publicUrl ?? null;

  const handleDeployPress = useCallback(() => {
    if (!session.website) return;

    const mode = session.status === "live" ? "redeploy" : "deploy";
    const label = formatVersion(session.website.version);

    if (mode === "redeploy") {
      setConfirm({
        title: `Redeploy ${label}?`,
        description: `This publishes a new build of ${label} with the ${session.adapterLabel}. The version live right now keeps serving traffic until the new build succeeds.`,
        confirmLabel: `Redeploy ${label}`,
        tone: "primary",
        details: (
          <dl className="rounded-xl bg-gray-50 px-3 py-2 text-[11px] text-gray-600">
            <div className="flex justify-between gap-3 py-0.5">
              <dt>Adapter</dt>
              <dd className="font-medium text-gray-800">{session.adapterLabel}</dd>
            </div>
            <div className="flex justify-between gap-3 py-0.5">
              <dt>Version</dt>
              <dd className="font-medium text-gray-800">{label}</dd>
            </div>
            <div className="flex justify-between gap-3 py-0.5">
              <dt>Live now</dt>
              <dd className="font-mono text-gray-800">{liveUrl ?? "—"}</dd>
            </div>
          </dl>
        ),
        onConfirm: () => {
          void session.deploy("redeploy");
        },
      });
      return;
    }

    void session.deploy("deploy");
  }, [liveUrl, session]);

  const handleStopPress = useCallback(() => {
    setConfirm({
      title: "Stop this deployment?",
      description:
        "The simulated run halts immediately and nothing is published. A real integration would map this to the provider's cancel endpoint.",
      confirmLabel: "Stop deployment",
      tone: "danger",
      details: (
        <ul className="list-inside list-disc space-y-1 rounded-xl bg-red-50 px-3 py-2 text-[11px] text-red-800">
          <li>In-flight build output is discarded.</li>
          <li>
            {session.liveRecord
              ? `${formatVersion(session.liveRecord.version)} stays live — visitors see no change.`
              : "Nothing is published."}
          </li>
          <li>The stop is recorded in the deployment history.</li>
        </ul>
      ),
      onConfirm: () => {
        void session.stop();
      },
    });
  }, [session]);

  const handleDisconnectPress = useCallback(() => {
    setConfirm({
      title: `Disconnect ${session.providerLabel}?`,
      description:
        "The provider account is unlinked and new deployments are blocked until you connect again. Nothing is stored in this prototype, so only the on-screen adapter state changes.",
      confirmLabel: "Disconnect",
      tone: "danger",
      onConfirm: () => {
        void session.disconnect();
      },
    });
  }, [session]);

  const requestOpenUrl = useCallback((url: string) => {
    setConfirm({
      title: "Open the public URL?",
      description:
        "Nothing is fetched by this page. Your browser opens the placeholder address in a new tab. It uses the reserved .example.test domain, so it can never resolve to a real host.",
      confirmLabel: "Open in new tab",
      tone: "primary",
      details: (
        <p className="break-all rounded-lg bg-gray-50 px-3 py-2 font-mono text-[11px] text-gray-700">
          {url}
        </p>
      ),
      onConfirm: () => window.open(url, "_blank", "noopener,noreferrer"),
    });
  }, []);

  const scrollToLogs = useCallback(() => {
    document
      .getElementById("deployment-logs")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const handleViewLiveSite = useCallback(() => {
    void (async () => {
      const url = await session.resolvePublicUrl();
      if (url) requestOpenUrl(url);
    })();
  }, [requestOpenUrl, session]);

  const selectedRecord =
    session.deployments.find((record) => record.id === session.logsDeploymentId) ?? null;

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Admin · Prototype
          </p>
          <h1 className="mt-1 text-xl font-semibold text-gray-900 sm:text-2xl">
            Hosting &amp; Deployment
          </h1>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-gray-500 sm:text-sm">
            Publish a generated website through a provider adapter. Switching provider swaps the
            adapter behind this whole screen — same UI, different provider.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-gray-900 px-2.5 py-1 font-mono text-[10px] text-white">
            {session.adapterLabel}
          </span>
          <DeploymentStatusBadge status={session.status} size="lg" />
        </div>
      </header>

      {session.error ? (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-red-200 ring-inset">
          {session.error}
        </p>
      ) : null}

      {session.isLoading ? (
        <p className="rounded-xl bg-white px-3 py-2 text-xs text-gray-500 ring-1 ring-gray-200 ring-inset">
          Loading {session.providerLabel} state from its adapter…
        </p>
      ) : null}

      <Panel
        title="Deployment status"
        description="Where the most recent attempt stands. No deployment ever starts on its own."
      >
        <DeploymentStatusCard
          status={session.status}
          progress={session.progress}
          providerName={session.providerLabel}
          adapterLabel={session.adapterLabel}
          failureInjection={failureMode}
          version={version}
          isStopping={session.isStopping}
          phaseAtFailure={session.phaseAtFailure}
          liveRecord={session.liveRecord}
          lastDeploymentAt={session.website?.lastDeployedAt ?? null}
        />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-1">
          <Panel
            title="Hosting provider"
            description="Each provider has its own adapter, connection state, and history."
          >
            <ProviderSelector
              providers={providers}
              connections={connections}
              adapterInfo={adapterInfo}
              activeProviderId={activeProviderId}
              onSelect={onSelectProvider}
              disabled={session.isRunActive}
            />
          </Panel>

          <Panel
            title="Provider authentication"
            description="Conceptual connection state — no credentials are stored."
          >
            <ConnectionStateCard
              provider={providers.find((provider) => provider.id === activeProviderId) ?? null}
              connection={activeConnection}
              adapterLabel={session.adapterLabel}
              isHandshaking={session.isConnecting}
              canDisconnect={!session.isRunActive}
              onConnect={() => {
                void session.connect();
              }}
              onDisconnect={handleDisconnectPress}
            />
          </Panel>
        </div>

        <div className="flex flex-col gap-6 lg:col-span-2">
          <Panel
            title="Website information"
            description="What will be published, and where it is on this provider."
          >
            <WebsiteInfoCard
              website={session.website}
              providerName={session.providerLabel}
              status={session.status}
              liveRecord={session.liveRecord}
            />
          </Panel>

          <Panel
            title="Deployment controls"
            description="Deploy, stop, and inspect — all under your control."
          >
            <DeploymentControls
              status={session.status}
              version={version}
              providerName={session.providerLabel}
              adapterLabel={session.adapterLabel}
              capabilities={session.capabilities}
              isProviderConnected={activeConnection?.state === "connected"}
              isRunActive={session.isRunActive}
              isStopping={session.isStopping}
              isReady={isReady}
              publicUrl={liveUrl}
              blockedReason={blockedReason}
              onDeploy={handleDeployPress}
              onRequestStop={handleStopPress}
              onViewLiveSite={handleViewLiveSite}
              onViewLogs={scrollToLogs}
            />
          </Panel>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <TerminalPanel
          lines={session.terminalLines}
          isRunning={session.isRunActive}
          isStopping={session.isStopping}
          adapterLabel={session.adapterLabel}
          onClear={session.clearTerminal}
        />

        <Panel
          id="deployment-logs"
          title="Deployment logs"
          description="Timestamped output for the deployment you selected."
        >
          <DeploymentLogsPanel
            entries={session.logs}
            targetLabel={
              selectedRecord
                ? `${formatVersion(selectedRecord.version)} · ${selectedRecord.id}`
                : "no deployment selected"
            }
            targetStatus={selectedRecord?.status ?? null}
            isStreaming={
              session.isRunActive && session.logsDeploymentId === session.activeRunDeploymentId
            }
          />
        </Panel>
      </div>

      <Panel
        title="Deployment history"
        description="Newest first, per provider. Failures and stops stay visible so nothing is silently overwritten."
        action={
          <span className="text-[11px] text-gray-400">
            {session.deployments.length} {session.deployments.length === 1 ? "run" : "runs"} on{" "}
            {session.providerLabel}
          </span>
        }
      >
        <DeploymentHistory
          deployments={session.deployments}
          providerLabelFor={providerLabelFor}
          currentRecordId={session.liveRecord?.id ?? null}
          selectedDeploymentId={session.logsDeploymentId}
          onViewLogs={(record) => {
            void session.viewLogs(record);
          }}
          onViewLiveSite={requestOpenUrl}
        />
      </Panel>

      <StickyDeploymentBar
        status={session.status}
        version={version}
        capabilities={session.capabilities}
        isRunActive={session.isRunActive}
        isStopping={session.isStopping}
        isReady={isReady}
        onDeploy={handleDeployPress}
        onRequestStop={handleStopPress}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        description={confirm?.description ?? ""}
        confirmLabel={confirm?.confirmLabel ?? "Confirm"}
        tone={confirm?.tone ?? "primary"}
        details={confirm?.details}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm?.onConfirm;
          setConfirm(null);
          action?.();
        }}
      />
    </div>
  );
}
