import type { ConnectionState, DeploymentStatus, FailureMode } from "../types";

interface DeploymentStatusMeta {
  label: string;
  /** Short explanation shown under the big status badge. */
  description: string;
  badge: string;
  dot: string;
  /** Progress bar fill class. */
  bar: string;
  /** Progress bar track class. */
  track: string;
  /** A simulated run is currently streaming output for this status. */
  isActive: boolean;
  /** Terminal — no further progress expected. */
  isFinal: boolean;
}

export const DEPLOYMENT_STATUS_META: Record<DeploymentStatus, DeploymentStatusMeta> = {
  not_deployed: {
    label: "Not deployed",
    description: "This website has never been published to this provider. Nothing happens until you press Deploy.",
    badge: "bg-gray-100 text-gray-600 ring-gray-200",
    dot: "bg-gray-400",
    bar: "bg-gray-300",
    track: "bg-gray-100",
    isActive: false,
    isFinal: true,
  },
  preparing: {
    label: "Preparing",
    description: "Collecting the generated files and checking the provider connection.",
    badge: "bg-sky-100 text-sky-700 ring-sky-200",
    dot: "bg-sky-500",
    bar: "bg-sky-500",
    track: "bg-sky-100",
    isActive: true,
    isFinal: false,
  },
  building: {
    label: "Building",
    description: "Running the production build for this website version.",
    badge: "bg-amber-100 text-amber-700 ring-amber-200",
    dot: "bg-amber-500",
    bar: "bg-amber-500",
    track: "bg-amber-100",
    isActive: true,
    isFinal: false,
  },
  deploying: {
    label: "Deploying",
    description: "Uploading the build output and promoting it to the provider.",
    badge: "bg-blue-100 text-blue-700 ring-blue-200",
    dot: "bg-blue-500",
    bar: "bg-blue-500",
    track: "bg-blue-100",
    isActive: true,
    isFinal: false,
  },
  live: {
    label: "Live",
    description: "This version is published on this provider and serving traffic.",
    badge: "bg-emerald-100 text-emerald-700 ring-emerald-200",
    dot: "bg-emerald-500",
    bar: "bg-emerald-500",
    track: "bg-emerald-100",
    isActive: false,
    isFinal: true,
  },
  failed: {
    label: "Failed",
    description: "The deployment did not finish. The previously live version is untouched.",
    badge: "bg-red-100 text-red-700 ring-red-200",
    dot: "bg-red-500",
    bar: "bg-red-500",
    track: "bg-red-100",
    isActive: false,
    isFinal: true,
  },
  stopped: {
    label: "Stopped",
    description: "You stopped this deployment. Nothing else runs automatically.",
    badge: "bg-slate-200 text-slate-700 ring-slate-300",
    dot: "bg-slate-500",
    bar: "bg-slate-400",
    track: "bg-slate-100",
    isActive: false,
    isFinal: true,
  },
};

/** Ordered phases drawn in the status timeline (excludes `not_deployed`). */
export const DEPLOYMENT_PHASES: DeploymentStatus[] = [
  "preparing",
  "building",
  "deploying",
  "live",
];

const PROGRESS_BY_STATUS: Record<DeploymentStatus, number> = {
  not_deployed: 0,
  preparing: 15,
  building: 45,
  deploying: 80,
  live: 100,
  failed: 100,
  stopped: 100,
};

export function deploymentProgress(status: DeploymentStatus): number {
  return PROGRESS_BY_STATUS[status];
}

export function isActiveStatus(status: DeploymentStatus): boolean {
  return DEPLOYMENT_STATUS_META[status].isActive;
}

interface ConnectionStateMeta {
  label: string;
  description: string;
  badge: string;
  dot: string;
}

export const CONNECTION_STATE_META: Record<ConnectionState, ConnectionStateMeta> = {
  not_connected: {
    label: "Not connected",
    description:
      "No provider account is linked yet. Connecting runs a simulated authorization handshake — no window opens and no token is stored.",
    badge: "bg-gray-100 text-gray-600 ring-gray-200",
    dot: "bg-gray-400",
  },
  connected: {
    label: "Connected",
    description: "A provider account is linked and ready to receive a deployment.",
    badge: "bg-emerald-100 text-emerald-700 ring-emerald-200",
    dot: "bg-emerald-500",
  },
  auth_required: {
    label: "Authentication required",
    description:
      "The provider asked for a fresh sign-in. Deployment stays blocked until the session is renewed.",
    badge: "bg-amber-100 text-amber-800 ring-amber-200",
    dot: "bg-amber-500",
  },
};

interface FailureModeMeta {
  label: string;
  description: string;
  /** Phase the injected failure stops at. */
  phase: DeploymentStatus;
  /** Whether the injection also drops the provider session. */
  affectsConnection: boolean;
}

export const FAILURE_MODE_META: Record<FailureMode, FailureModeMeta> = {
  none: {
    label: "No failure",
    description: "The next operation behaves normally.",
    phase: "live",
    affectsConnection: false,
  },
  build: {
    label: "Build failure",
    description: "The next deployment fails while building. Nothing is published.",
    phase: "building",
    affectsConnection: false,
  },
  deploy: {
    label: "Deployment failure",
    description: "The next deployment fails while uploading. Nothing is published.",
    phase: "deploying",
    affectsConnection: false,
  },
  auth: {
    label: "Authentication failure",
    description:
      "The next deploy (or connect) fails with an expired session and leaves the provider needing authentication.",
    phase: "deploying",
    affectsConnection: true,
  },
};
