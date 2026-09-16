"use client";

import type { PrototypeDeploymentProvider, ProviderConnection } from "../types";
import { CONNECTION_STATE_META } from "../lib/status";
import { formatDateTime, formatRelativeTime } from "../lib/format";
import { Button } from "./button";
import { ConnectionStateBadge } from "./status-badge";

export interface ConnectionStateCardProps {
  provider: PrototypeDeploymentProvider | null;
  connection: ProviderConnection | null;
  adapterLabel: string | null;
  /** A simulated handshake is streaming right now. */
  isHandshaking: boolean;
  /** Disconnect is blocked while a simulated run is streaming. */
  canDisconnect: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}

/**
 * Provider authentication state.
 *
 * The three states the eventual integration must handle:
 *   not_connected → (connect) → auth_required → connected
 *
 * Connecting runs a purely on-screen handshake: the steps stream into the
 * console, the card passes through "Authentication required", and nothing is
 * ever stored. A real adapter would finish this in a server route and keep the
 * token server-side.
 */
export function ConnectionStateCard({
  provider,
  connection,
  adapterLabel,
  isHandshaking,
  canDisconnect,
  onConnect,
  onDisconnect,
}: ConnectionStateCardProps) {
  const state = connection?.state ?? "not_connected";
  const meta = CONNECTION_STATE_META[state];
  const isConnected = state === "connected";
  const providerName = provider?.name ?? "No provider selected";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ConnectionStateBadge state={state} />
        <span className="text-xs text-gray-500">{providerName}</span>
      </div>

      <p className="text-xs leading-relaxed text-gray-600">{meta.description}</p>

      <ol className="flex items-center gap-1.5 text-[10px]">
        {(["not_connected", "auth_required", "connected"] as const).map((step, index) => {
          const reached =
            index === 0 ||
            (index === 1 && (state === "auth_required" || isConnected)) ||
            (index === 2 && isConnected);
          return (
            <li key={step} className="flex flex-1 items-center gap-1.5">
              <span
                className={`h-1.5 flex-1 rounded-full ${
                  reached ? "bg-emerald-400" : "bg-gray-200"
                }`}
              />
              <span className={reached ? "text-gray-600" : "text-gray-400"}>
                {CONNECTION_STATE_META[step].label}
              </span>
              {index < 2 ? <span className="text-gray-300">›</span> : null}
            </li>
          );
        })}
      </ol>

      {isHandshaking ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 ring-1 ring-amber-200 ring-inset">
          Simulated authorization in progress — the handshake steps stream into the console below.
        </p>
      ) : null}

      <dl className="rounded-xl bg-gray-50 px-3 py-2">
        <div className="flex items-center justify-between gap-3 py-1">
          <dt className="text-xs text-gray-500">Adapter</dt>
          <dd className="truncate text-xs font-medium text-gray-900">{adapterLabel ?? "—"}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-1">
          <dt className="text-xs text-gray-500">Account</dt>
          <dd className="truncate text-right text-xs font-medium text-gray-900">
            {connection?.accountLabel ?? "—"}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-1">
          <dt className="text-xs text-gray-500">Scopes</dt>
          <dd className="truncate text-right text-xs text-gray-700">
            {connection && connection.scopes.length > 0 ? connection.scopes.join(", ") : "—"}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-1">
          <dt className="text-xs text-gray-500">Last checked</dt>
          <dd className="text-right text-xs text-gray-700">
            {connection?.lastCheckedAt
              ? `${formatRelativeTime(connection.lastCheckedAt)} · ${formatDateTime(connection.lastCheckedAt)}`
              : "never"}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant={isConnected ? "secondary" : "primary"}
          size="md"
          fullWidth
          disabled={!provider || isHandshaking}
          onClick={onConnect}
        >
          {isHandshaking
            ? "Authorizing…"
            : state === "auth_required"
              ? "Reconnect (simulated)"
              : state === "connected"
                ? "Refresh session"
                : "Connect provider"}
        </Button>
        {isConnected ? (
          <Button
            variant="ghost"
            size="md"
            fullWidth
            disabled={!canDisconnect}
            onClick={onDisconnect}
            className="text-red-600 hover:bg-red-50"
          >
            Disconnect
          </Button>
        ) : null}
      </div>

      <p className="text-[11px] leading-relaxed text-gray-400">
        No OAuth window opens, no token is requested, and no credential is stored. The connection
        exists only in this adapter&rsquo;s memory for as long as the page is open.
      </p>
    </div>
  );
}
