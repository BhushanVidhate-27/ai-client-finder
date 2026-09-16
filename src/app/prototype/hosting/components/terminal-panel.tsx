"use client";

import { useEffect, useRef } from "react";
import type { LogEntry, LogLevel } from "../types";
import { formatClockTime } from "../lib/format";
import { Button } from "./button";

const LEVEL_STYLES: Record<LogLevel, string> = {
  command: "text-emerald-300",
  info: "text-gray-300",
  success: "text-emerald-400",
  warn: "text-amber-300",
  error: "text-red-400",
  auth: "text-sky-300",
};

const LEVEL_GLYPHS: Record<LogLevel, string> = {
  command: "❯",
  info: "·",
  success: "✓",
  warn: "!",
  error: "✗",
  auth: "→",
};

export interface TerminalPanelProps {
  lines: LogEntry[];
  isRunning: boolean;
  isStopping: boolean;
  adapterLabel: string;
  onClear: () => void;
}

/**
 * Terminal-style output panel.
 *
 * Everything shown here is a string from local mock data, appended on a timer.
 * No shell, child process, or network call is involved anywhere in this folder.
 */
export function TerminalPanel({
  lines,
  isRunning,
  isStopping,
  adapterLabel,
  onClear,
}: TerminalPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lines.length]);

  return (
    <section
      aria-label="Simulated deployment console"
      className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-950 shadow-sm"
    >
      <header className="flex items-center justify-between gap-3 border-b border-gray-800 bg-gray-900 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="flex flex-none items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
          </span>
          <span className="truncate font-mono text-xs text-gray-400">
            deployment-console — {adapterLabel}
          </span>
        </div>
        <div className="flex flex-none items-center gap-2">
          <span className="hidden rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300 ring-1 ring-amber-400/30 ring-inset sm:inline">
            Simulated
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="text-gray-300 hover:bg-gray-800 hover:text-white"
          >
            Clear
          </Button>
        </div>
      </header>

      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label="Simulated terminal output"
        className="h-64 overflow-y-auto px-3 py-3 font-mono text-[11px] leading-relaxed sm:h-80 sm:px-4 sm:text-xs"
      >
        {lines.length === 0 ? (
          <p className="text-gray-500"># console cleared — press Deploy to start a simulated run.</p>
        ) : null}

        {lines.map((line) => (
          <div key={line.id} className="flex gap-2">
            <span className="flex-none select-none text-gray-600">{formatClockTime(line.at)}</span>
            <span className={`flex-none select-none ${LEVEL_STYLES[line.level]}`}>
              {LEVEL_GLYPHS[line.level]}
            </span>
            <span className={`min-w-0 whitespace-pre-wrap break-words ${LEVEL_STYLES[line.level]}`}>
              {line.text}
            </span>
          </div>
        ))}

        {isRunning ? (
          <div className="flex gap-2 pt-1">
            <span className="flex-none select-none text-gray-600">{" ".repeat(8)}</span>
            <span className="animate-pulse text-emerald-400">▌</span>
          </div>
        ) : null}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-800 bg-gray-900 px-3 py-2 sm:px-4">
        <span className="text-[10px] leading-relaxed text-gray-500">
          This console does not execute anything. Lines are mock strings revealed on a timer.
        </span>
        <span
          className={`inline-flex items-center gap-1.5 text-[10px] font-medium ${
            isStopping ? "text-amber-300" : isRunning ? "text-emerald-400" : "text-gray-500"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              isStopping ? "bg-amber-400" : isRunning ? "bg-emerald-400" : "bg-gray-600"
            }`}
          />
          {isStopping ? "stopping" : isRunning ? "run in progress" : "idle"}
        </span>
      </footer>
    </section>
  );
}
