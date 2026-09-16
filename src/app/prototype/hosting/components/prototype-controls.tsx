"use client";

import type { FailureMode } from "../types";
import { FAILURE_MODE_META } from "../lib/status";
import { DeploymentStatusBadge } from "./status-badge";
import { Button } from "./button";

export interface PrototypeControlsProps {
  failureMode: FailureMode;
  onArmFailure: (mode: FailureMode) => void;
  onReset: () => void;
}

const MODES: FailureMode[] = ["none", "build", "deploy", "auth"];

/**
 * Demo-only controls.
 *
 * This is the "development build only" affordance the prototype needs in order
 * to reach the failure paths: arm a failure, then Deploy and watch the run stop
 * at that phase. The injection is one-shot, so Retry afterwards succeeds — which
 * is exactly the flow a real provider integration has to support.
 */
export function PrototypeControls({
  failureMode,
  onArmFailure,
  onReset,
}: PrototypeControlsProps) {
  const armed = failureMode !== "none";
  const meta = FAILURE_MODE_META[failureMode];

  return (
    <section
      aria-label="Demo controls"
      className="rounded-2xl border-2 border-dashed border-violet-300 bg-violet-50/70 px-4 py-4 sm:px-5"
    >
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold text-violet-900">
            Demo controls · simulate a provider failure
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-violet-800">
            Arm a failure and the next provider operation fails on purpose, so Retry and Redeploy can
            be exercised. The injection clears itself the moment it fires — nothing here touches a
            real provider.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Simulated provider failure"
          className="grid grid-cols-2 gap-2 lg:grid-cols-4"
        >
          {MODES.map((mode) => {
            const modeMeta = FAILURE_MODE_META[mode];
            const selected = failureMode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onArmFailure(mode)}
                className={`rounded-xl border px-3 py-2 text-left transition ${
                  selected
                    ? "border-violet-700 bg-white ring-1 ring-violet-700 ring-inset"
                    : "border-violet-200 bg-white/60 hover:bg-white"
                }`}
              >
                <span className="block text-xs font-semibold text-gray-900">{modeMeta.label}</span>
                <span className="mt-0.5 block text-[10px] leading-snug text-gray-500">
                  {modeMeta.description}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button variant="secondary" size="sm" onClick={onReset}>
            Reset all adapters
          </Button>

          {armed ? (
            <span className="flex flex-wrap items-center gap-2 text-[11px] text-violet-900">
              <span className="font-medium">{meta.label} armed</span>
              <span className="text-violet-700">stops at</span>
              <DeploymentStatusBadge status={meta.phase} size="sm" />
              {meta.affectsConnection ? (
                <span className="text-violet-700">and drops the provider session</span>
              ) : null}
            </span>
          ) : (
            <span className="text-[11px] text-violet-800">
              No failure armed — the next run follows the happy path.
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
