"use client";

import { useMemo, useState } from "react";
import type { DeploymentStatus, LogEntry, LogLevel } from "../types";
import { formatClockTime, formatDateTime } from "../lib/format";
import { isActiveStatus } from "../lib/status";

const LEVEL_STYLES: Record<LogLevel, string> = {
  command: "bg-gray-100 text-gray-700 ring-gray-200",
  info: "bg-gray-100 text-gray-600 ring-gray-200",
  success: "bg-emerald-100 text-emerald-700 ring-emerald-200",
  warn: "bg-amber-100 text-amber-800 ring-amber-200",
  error: "bg-red-100 text-red-700 ring-red-200",
  auth: "bg-sky-100 text-sky-700 ring-sky-200",
};

type LogFilter = "all" | "problems" | "commands";

const FILTERS: { id: LogFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "problems", label: "Warnings & errors" },
  { id: "commands", label: "Commands" },
];

export interface DeploymentLogsPanelProps {
  entries: LogEntry[];
  /** Label of the deployment the logs belong to, e.g. "v3 · dep_v3". */
  targetLabel: string;
  targetStatus: DeploymentStatus | null;
  isStreaming: boolean;
}

export function DeploymentLogsPanel({
  entries,
  targetLabel,
  targetStatus,
  isStreaming,
}: DeploymentLogsPanelProps) {
  const [filter, setFilter] = useState<LogFilter>("all");

  const visible = useMemo(() => {
    if (filter === "problems") {
      return entries.filter((entry) => entry.level === "warn" || entry.level === "error");
    }
    if (filter === "commands") {
      return entries.filter((entry) => entry.level === "command");
    }
    return entries;
  }, [entries, filter]);

  const counts = useMemo(
    () => ({
      problems: entries.filter((entry) => entry.level === "warn" || entry.level === "error").length,
      commands: entries.filter((entry) => entry.level === "command").length,
    }),
    [entries],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-gray-500">
          <span className="font-mono text-gray-700">{targetLabel}</span>
          {isStreaming ? (
            <span className="ml-2 inline-flex items-center gap-1 text-emerald-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              streaming
            </span>
          ) : null}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((option) => {
            const count =
              option.id === "problems"
                ? counts.problems
                : option.id === "commands"
                  ? counts.commands
                  : entries.length;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setFilter(option.id)}
                aria-pressed={filter === option.id}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                  filter === option.id
                    ? "bg-gray-900 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {option.label} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {targetStatus && isActiveStatus(targetStatus) ? (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-[11px] text-sky-800 ring-1 ring-sky-200 ring-inset">
          Timestamps are generated locally as each simulated line appears.
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-400">
          {entries.length === 0
            ? "No log lines for this deployment yet."
            : "No lines match this filter."}
        </p>
      ) : (
        <ul className="max-h-80 divide-y divide-gray-100 overflow-y-auto rounded-xl border border-gray-100">
          {visible.map((entry) => (
            <li key={entry.id} className="flex gap-3 px-3 py-2">
              <time
                dateTime={entry.at}
                title={formatDateTime(entry.at)}
                className="flex-none pt-px font-mono text-[11px] tabular-nums text-gray-400"
              >
                {formatClockTime(entry.at)}
              </time>
              <span
                className={`mt-px h-fit flex-none rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ring-1 ring-inset ${LEVEL_STYLES[entry.level]}`}
              >
                {entry.level}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block whitespace-pre-wrap break-words text-xs text-gray-700">
                  {entry.text}
                </span>
                <span className="block text-[10px] text-gray-400">{entry.source}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
