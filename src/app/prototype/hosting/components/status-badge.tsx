import type { ConnectionState, DeploymentStatus } from "../types";
import { CONNECTION_STATE_META, DEPLOYMENT_STATUS_META, isActiveStatus } from "../lib/status";
import { formatVersion } from "../lib/format";

const BADGE_SIZES = {
  sm: "px-2 py-0.5 text-[11px]",
  md: "px-2.5 py-1 text-xs",
  lg: "px-3 py-1.5 text-sm",
} as const;

/** Pulsing dot shown while a simulated run is streaming output. */
export function ActivityDot({ className = "" }: { className?: string }) {
  return (
    <span className={`relative flex h-2 w-2 ${className}`}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
    </span>
  );
}

export function DeploymentStatusBadge({
  status,
  size = "md",
}: {
  status: DeploymentStatus;
  size?: keyof typeof BADGE_SIZES;
}) {
  const meta = DEPLOYMENT_STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset ${meta.badge} ${BADGE_SIZES[size]}`}
    >
      {isActiveStatus(status) ? (
        <ActivityDot />
      ) : (
        <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      )}
      {meta.label}
    </span>
  );
}

export function ConnectionStateBadge({
  state,
  size = "md",
}: {
  state: ConnectionState;
  size?: keyof typeof BADGE_SIZES;
}) {
  const meta = CONNECTION_STATE_META[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset ${meta.badge} ${BADGE_SIZES[size]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

export function VersionBadge({
  version,
  isCurrent = false,
}: {
  version: number;
  isCurrent?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs font-semibold ${
        isCurrent
          ? "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200 ring-inset"
          : "bg-gray-100 text-gray-700 ring-1 ring-gray-200 ring-inset"
      }`}
    >
      {formatVersion(version)}
      {isCurrent ? <span className="font-sans text-[10px] font-medium">CURRENT</span> : null}
    </span>
  );
}

export function Tag({
  children,
  tone = "gray",
}: {
  children: React.ReactNode;
  tone?: "gray" | "emerald" | "sky" | "amber";
}) {
  const tones = {
    gray: "bg-gray-100 text-gray-600 ring-gray-200",
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    sky: "bg-sky-50 text-sky-700 ring-sky-200",
    amber: "bg-amber-100 text-amber-800 ring-amber-300",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
