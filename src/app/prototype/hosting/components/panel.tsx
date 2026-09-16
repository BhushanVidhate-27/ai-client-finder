import type { ReactNode } from "react";

export interface PanelProps {
  /** Anchor target, used by the "Deployment Logs" control. */
  id?: string;
  title: string;
  description?: string;
  /** Rendered on the right of the header, e.g. a badge or a small action. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Removes the inner padding for panels that render their own layout. */
  flush?: boolean;
}

export function Panel({
  id,
  title,
  description,
  action,
  children,
  className = "",
  flush = false,
}: PanelProps) {
  return (
    <section
      id={id}
      aria-label={title}
      className={`overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm ${className}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-gray-100 bg-white px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-gray-500">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex flex-none items-center gap-2">{action}</div> : null}
      </header>
      <div className={flush ? "" : "px-4 py-4 sm:px-5"}>{children}</div>
    </section>
  );
}

export interface InfoRowProps {
  label: string;
  children: ReactNode;
  /** Renders the value in a monospace font, e.g. for IDs and URLs. */
  mono?: boolean;
}

export function InfoRow({ label, children, mono = false }: InfoRowProps) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-gray-100 py-2.5 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-xs font-medium text-gray-500">{label}</dt>
      <dd
        className={`min-w-0 text-sm text-gray-900 sm:text-right ${
          mono ? "font-mono text-xs break-all" : ""
        }`}
      >
        {children}
      </dd>
    </div>
  );
}
