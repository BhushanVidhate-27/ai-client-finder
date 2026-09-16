import type { ReactNode } from "react";
import { Tag } from "./status-badge";

/**
 * Persistent reminder that this screen is a design prototype.
 *
 * It is intentionally loud: the safest failure mode for this UI is someone
 * mistaking simulated output for a real deployment.
 */
export function PrototypeBanner({ children }: { children?: ReactNode }) {
  return (
    <aside
      aria-label="Prototype notice"
      className="rounded-2xl border-2 border-dashed border-amber-300 bg-amber-50/80 px-4 py-3 sm:px-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex-none">
            <Tag tone="gray">Prototype</Tag>
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-900">Simulated hosting UI — nothing is real</p>
            <p className="mt-0.5 text-xs leading-relaxed text-amber-800">
              No command is executed, no build runs, no credentials are stored, and no provider API is
              contacted. Terminal output and statuses below are local mock data streamed by a timer.
            </p>
          </div>
        </div>
        {children ? <div className="flex-none">{children}</div> : null}
      </div>
    </aside>
  );
}
