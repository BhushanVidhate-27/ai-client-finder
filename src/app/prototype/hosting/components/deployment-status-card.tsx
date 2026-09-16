import type { DeploymentRecord, DeploymentStatus, FailureMode } from "../types";
import { DEPLOYMENT_PHASES, DEPLOYMENT_STATUS_META, FAILURE_MODE_META } from "../lib/status";
import { formatRelativeTime, formatVersion } from "../lib/format";
import { ActivityDot, DeploymentStatusBadge } from "./status-badge";

export interface DeploymentStatusCardProps {
  status: DeploymentStatus;
  progress: number;
  providerName: string;
  adapterLabel: string;
  /** Demo failure armed for the next run, if any. */
  failureInjection: FailureMode;
  version: number;
  isStopping: boolean;
  /** Which phase the run had reached when it failed or was stopped. */
  phaseAtFailure: DeploymentStatus | null;
  liveRecord: DeploymentRecord | null;
  lastDeploymentAt: string | null;
}

type PhaseState = "done" | "active" | "pending" | "failed" | "halted";

const PHASE_STYLES: Record<PhaseState, { dot: string; text: string; label: string }> = {
  done: { dot: "bg-emerald-500 text-emerald-600", text: "text-gray-700", label: "Done" },
  active: { dot: "bg-sky-500 text-sky-600", text: "text-gray-900 font-medium", label: "In progress" },
  pending: { dot: "bg-gray-200 text-gray-300", text: "text-gray-400", label: "Waiting" },
  failed: { dot: "bg-red-500 text-red-600", text: "text-red-700", label: "Failed here" },
  halted: { dot: "bg-slate-400 text-slate-500", text: "text-slate-700", label: "Stopped here" },
};

function resolvePhaseState(
  index: number,
  status: DeploymentStatus,
  phaseAtFailure: DeploymentStatus | null,
): PhaseState {
  if (status === "not_deployed") return "pending";

  if (status === "live") return "done";

  if (status === "failed" || status === "stopped") {
    const failureIndex = phaseAtFailure ? DEPLOYMENT_PHASES.indexOf(phaseAtFailure) : 0;
    const haltedState: PhaseState = status === "failed" ? "failed" : "halted";
    if (index < failureIndex) return "done";
    if (index === failureIndex) return haltedState;
    return "pending";
  }

  const currentIndex = DEPLOYMENT_PHASES.indexOf(status);
  if (index < currentIndex) return "done";
  if (index === currentIndex) return "active";
  return "pending";
}

export function DeploymentStatusCard({
  status,
  progress,
  providerName,
  adapterLabel,
  failureInjection,
  version,
  isStopping,
  phaseAtFailure,
  liveRecord,
  lastDeploymentAt,
}: DeploymentStatusCardProps) {
  const meta = DEPLOYMENT_STATUS_META[status];
  const liveVersion = liveRecord?.version ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <DeploymentStatusBadge status={status} size="lg" />
            <span className="text-xs text-gray-500">
              {formatVersion(version)} · {providerName}
            </span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[10px] text-gray-500">
              {adapterLabel}
            </span>
          </div>
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-gray-600">
            {isStopping ? "Stopping the simulated deployment on your instruction…" : meta.description}
          </p>
        </div>

        <div className="text-right">
          <p className="text-2xl font-semibold tabular-nums text-gray-900">{progress}%</p>
          <p className="text-[11px] text-gray-400">
            {lastDeploymentAt ? `Last deploy ${formatRelativeTime(lastDeploymentAt)}` : "Not deployed yet"}
          </p>
        </div>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-label="Deployment progress"
        className={`h-2 w-full overflow-hidden rounded-full ${meta.track}`}
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ${meta.bar}`}
          style={{ width: `${progress}%` }}
        />
      </div>

      <ol className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
        {DEPLOYMENT_PHASES.map((phase, index) => {
          const state = resolvePhaseState(index, status, phaseAtFailure);
          const styles = PHASE_STYLES[state];
          return (
            <li key={phase} className="flex items-center gap-2 sm:flex-1 sm:gap-2">
              <span className={`flex-none ${styles.dot}`}>
                {state === "active" ? (
                  <ActivityDot />
                ) : (
                  <span className="block h-2 w-2 rounded-full bg-current" />
                )}
              </span>
              <span className="min-w-0">
                <span className={`block text-xs ${styles.text}`}>
                  {DEPLOYMENT_STATUS_META[phase].label}
                </span>
                <span className="block text-[10px] text-gray-400">{styles.label}</span>
              </span>
              {index < DEPLOYMENT_PHASES.length - 1 ? (
                <span aria-hidden className="hidden flex-1 border-t border-dashed border-gray-200 sm:block" />
              ) : null}
            </li>
          );
        })}
      </ol>

      {failureInjection !== "none" ? (
        <p className="rounded-lg bg-violet-50 px-3 py-2 text-xs leading-relaxed text-violet-900 ring-1 ring-violet-200 ring-inset">
          Failure injection armed: the next run stops at the{" "}
          {FAILURE_MODE_META[failureInjection].phase} phase ({FAILURE_MODE_META[failureInjection].label})
          {FAILURE_MODE_META[failureInjection].affectsConnection
            ? " and leaves the provider needing authentication"
            : ""}
          . Retry afterwards succeeds.
        </p>
      ) : null}

      {status === "failed" ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-800 ring-1 ring-red-200 ring-inset">
          The deployment failed and stopped there.{" "}
          {liveVersion
            ? `${formatVersion(liveVersion)} is still live, so visitors see no change.`
            : "Nothing was published."}
        </p>
      ) : null}

      {status === "stopped" ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-700 ring-1 ring-slate-200 ring-inset">
          You stopped this run.{" "}
          {liveVersion
            ? `${formatVersion(liveVersion)} remains online; no partial build was published.`
            : "Nothing was published."}
        </p>
      ) : null}

      {status === "not_deployed" ? (
        <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600 ring-1 ring-gray-200 ring-inset">
          Nothing is running. Automatic deploys are disabled in this prototype — a deployment only
          starts from the Deploy button below.
        </p>
      ) : null}
    </div>
  );
}
