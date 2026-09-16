"use client";

import type { DeploymentRecord, ProviderId } from "../types";
import { DEPLOYMENT_STATUS_META } from "../lib/status";
import { formatDateTime, formatDuration, formatHost, formatRelativeTime, formatVersion } from "../lib/format";
import { Button } from "./button";
import { DeploymentStatusBadge, VersionBadge } from "./status-badge";

const STATUS_GLYPHS: Record<string, string> = {
  live: "✓",
  failed: "✗",
  stopped: "■",
  deploying: "↑",
  building: "⚙",
  preparing: "·",
  not_deployed: "·",
};

export interface DeploymentHistoryProps {
  deployments: DeploymentRecord[];
  providerLabelFor: (providerId: ProviderId) => string;
  /** Record that currently serves traffic. */
  currentRecordId: string | null;
  selectedDeploymentId: string | null;
  onViewLogs: (record: DeploymentRecord) => void;
  /** Opening a URL always goes through an explicit confirmation. */
  onViewLiveSite: (url: string) => void;
}

export function DeploymentHistory({
  deployments,
  providerLabelFor,
  currentRecordId,
  selectedDeploymentId,
  onViewLogs,
  onViewLiveSite,
}: DeploymentHistoryProps) {
  if (deployments.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-400">
        No deployments yet. The first run you start will appear here as v1.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-2">
      {deployments.map((record) => {
        const isCurrent = record.id === currentRecordId;
        const isSelected = record.id === selectedDeploymentId;
        const meta = DEPLOYMENT_STATUS_META[record.status];

        return (
          <li
            key={record.id}
            className={`rounded-xl border px-3 py-3 transition ${
              isSelected ? "border-gray-900 ring-1 ring-gray-900 ring-inset" : "border-gray-200"
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-xs ${meta.badge}`}
                >
                  {STATUS_GLYPHS[record.status] ?? "·"}
                </span>
                <VersionBadge version={record.version} isCurrent={isCurrent} />
                <DeploymentStatusBadge status={record.status} size="sm" />
              </div>
              <span className="text-[11px] text-gray-400">
                {formatRelativeTime(record.startedAt)}
              </span>
            </div>

            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-4">
              <div className="min-w-0">
                <dt className="text-gray-400">Started</dt>
                <dd className="truncate text-gray-700">{formatDateTime(record.startedAt)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-gray-400">Duration</dt>
                <dd className="truncate text-gray-700">{formatDuration(record.durationMs)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-gray-400">Provider</dt>
                <dd className="truncate text-gray-700">{providerLabelFor(record.providerId)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-gray-400">URL</dt>
                <dd className="truncate font-mono text-gray-700">
                  {record.publicUrl ? formatHost(record.publicUrl) : "—"}
                </dd>
              </div>
            </dl>

            {record.note ? (
              <p
                className={`mt-2 text-[11px] leading-relaxed ${
                  record.status === "failed"
                    ? "text-red-700"
                    : record.status === "stopped"
                      ? "text-slate-600"
                      : "text-gray-500"
                }`}
              >
                {record.note}
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => onViewLogs(record)}>
                {isSelected ? "Viewing logs" : `View ${formatVersion(record.version)} logs`}
              </Button>
              {record.publicUrl ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onViewLiveSite(record.publicUrl as string)}
                  className="text-blue-600 hover:bg-blue-50"
                >
                  View site ↗
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
