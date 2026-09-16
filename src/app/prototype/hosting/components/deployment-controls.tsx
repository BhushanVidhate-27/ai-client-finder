"use client";

import type { ProviderCapabilities } from "../provider-contract";
import type { DeploymentStatus } from "../types";
import { formatVersion } from "../lib/format";
import { ActivityDot } from "./status-badge";
import { Button } from "./button";

export interface DeploymentControlsProps {
  status: DeploymentStatus;
  version: number;
  providerName: string;
  adapterLabel: string;
  /** What the active adapter can do; drives which controls are offered. */
  capabilities: ProviderCapabilities;
  isProviderConnected: boolean;
  isRunActive: boolean;
  isStopping: boolean;
  isReady: boolean;
  publicUrl: string | null;
  /** Why deployment is currently blocked, if it is. */
  blockedReason: string | null;
  onDeploy: () => void;
  onRequestStop: () => void;
  onViewLiveSite: () => void;
  onViewLogs: () => void;
}

/** Explains that every action is user-initiated. */
export function ControlNotice({ blockedReason }: { blockedReason: string | null }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-start gap-2 rounded-lg bg-gray-50 px-3 py-2 text-[11px] leading-relaxed text-gray-600 ring-1 ring-gray-200 ring-inset">
        <span aria-hidden className="mt-px text-gray-400">
          ▣
        </span>
        <span>
          <span className="font-semibold text-gray-700">You are in control.</span> Nothing deploys on
          its own — no webhooks, no schedules, no auto-retries. Deploy runs only when you press the
          button, and Stop takes effect immediately.
        </span>
      </p>
      {blockedReason ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 ring-1 ring-amber-200 ring-inset">
          {blockedReason}
        </p>
      ) : null}
    </div>
  );
}

function stopLabel(isStopping: boolean): string {
  return isStopping ? "Stopping…" : "Stop deployment";
}

function primaryLabel(
  status: DeploymentStatus,
  version: number,
  capabilities: ProviderCapabilities,
): string {
  if (status === "live") {
    return capabilities.canRedeploy
      ? `Redeploy ${formatVersion(version)}`
      : `Deploy ${formatVersion(version)} again`;
  }
  return status === "failed" ? "Retry deployment" : `Deploy ${formatVersion(version)}`;
}

/** Shown when a run is streaming but the adapter cannot cancel it. */
function CannotStopNotice({ providerName }: { providerName: string }) {
  return (
    <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 ring-1 ring-amber-200 ring-inset">
      <span className="font-semibold">Stop is unavailable.</span> The {providerName} adapter has no
      cancel operation (<code>canStop: false</code>), so this run has to finish or time out. The UI
      hides Stop rather than pretending it works.
    </p>
  );
}

export function DeploymentControls({
  status,
  version,
  providerName,
  adapterLabel,
  capabilities,
  isProviderConnected,
  isRunActive,
  isStopping,
  isReady,
  publicUrl,
  blockedReason,
  onDeploy,
  onRequestStop,
  onViewLiveSite,
  onViewLogs,
}: DeploymentControlsProps) {
  return (
    <div className="flex flex-col gap-3">
      {isRunActive ? (
        capabilities.canStop ? (
          <Button
            variant="danger"
            size="lg"
            fullWidth
            onClick={onRequestStop}
            disabled={isStopping}
            icon={!isStopping ? <ActivityDot /> : undefined}
            className="text-base shadow-lg shadow-red-600/25"
          >
            {stopLabel(isStopping)}
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="lg" fullWidth disabled>
              Running — cannot be stopped
            </Button>
            <CannotStopNotice providerName={providerName} />
          </>
        )
      ) : (
        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={onDeploy}
          disabled={!isReady || !capabilities.canDeploy}
        >
          {primaryLabel(status, version, capabilities)}
        </Button>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          size="md"
          onClick={onViewLiveSite}
          disabled={!publicUrl}
          title={publicUrl ?? "No live URL yet"}
        >
          View Live Site
        </Button>
        <Button variant="secondary" size="md" onClick={onViewLogs}>
          Deployment Logs
        </Button>
      </div>

      <ControlNotice blockedReason={blockedReason} />

      <p className="text-[11px] leading-relaxed text-gray-400">
        Adapter: {adapterLabel} · target: {providerName} ·{" "}
        {isProviderConnected ? "account connected" : "account not connected"} · deploy is never
        triggered by the app itself.
      </p>
    </div>
  );
}

export interface StickyDeploymentBarProps {
  status: DeploymentStatus;
  version: number;
  capabilities: ProviderCapabilities;
  isRunActive: boolean;
  isStopping: boolean;
  isReady: boolean;
  onDeploy: () => void;
  onRequestStop: () => void;
}

/**
 * Mobile-first action bar pinned to the bottom of the viewport.
 *
 * Stop stays reachable with one thumb, which matters on a phone.
 */
export function StickyDeploymentBar({
  status,
  version,
  capabilities,
  isRunActive,
  isStopping,
  isReady,
  onDeploy,
  onRequestStop,
}: StickyDeploymentBarProps) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white/95 px-4 pb-4 pt-3 backdrop-blur lg:hidden">
      {isRunActive && capabilities.canStop ? (
        <Button
          variant="danger"
          size="lg"
          fullWidth
          onClick={onRequestStop}
          disabled={isStopping}
          icon={!isStopping ? <ActivityDot /> : undefined}
          className="shadow-lg shadow-red-600/25"
        >
          {stopLabel(isStopping)}
        </Button>
      ) : isRunActive ? (
        <Button variant="secondary" size="lg" fullWidth disabled>
          Running — cannot be stopped
        </Button>
      ) : (
        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={onDeploy}
          disabled={!isReady || !capabilities.canDeploy}
        >
          {primaryLabel(status, version, capabilities)}
        </Button>
      )}
    </div>
  );
}
