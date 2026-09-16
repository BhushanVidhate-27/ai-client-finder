"use client";

import type { ProviderCapabilities } from "../provider-contract";
import type {
  PrototypeDeploymentProvider,
  ProviderConnection,
  ProviderId,
} from "../types";
import { ConnectionStateBadge, Tag } from "./status-badge";

export interface ProviderAdapterInfo {
  providerId: ProviderId;
  adapterLabel: string;
  capabilities: ProviderCapabilities;
}

export interface ProviderSelectorProps {
  providers: PrototypeDeploymentProvider[];
  connections: ProviderConnection[];
  /** Adapters the prototype actually has, keyed by provider. */
  adapterInfo: ProviderAdapterInfo[];
  activeProviderId: ProviderId | null;
  onSelect: (providerId: ProviderId) => void;
  /** Locked while a simulated run is streaming. */
  disabled?: boolean;
}

function CapabilityTags({ capabilities }: { capabilities: ProviderCapabilities }) {
  const entries: { label: string; supported: boolean }[] = [
    { label: "deploy", supported: capabilities.canDeploy },
    { label: "redeploy", supported: capabilities.canRedeploy },
    { label: "stop", supported: capabilities.canStop },
    { label: "custom domain", supported: capabilities.supportsCustomDomain },
  ];

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {entries.map((entry) => (
        <span
          key={entry.label}
          className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-inset ${
            entry.supported
              ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
              : "bg-gray-100 text-gray-400 ring-gray-200 line-through decoration-gray-400"
          }`}
        >
          {entry.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Provider picker.
 *
 * Selecting a provider swaps the adapter behind the whole dashboard, so the
 * selected card also shows which adapter is driving it and what that adapter
 * supports. Providers without an adapter stay listed as disabled entries.
 */
export function ProviderSelector({
  providers,
  connections,
  adapterInfo,
  activeProviderId,
  onSelect,
  disabled = false,
}: ProviderSelectorProps) {
  const withAdapter = (providerId: ProviderId) =>
    adapterInfo.find((info) => info.providerId === providerId) ?? null;

  const available = providers.filter(
    (provider) => provider.availability === "available" && withAdapter(provider.id) !== null,
  );
  const upcoming = providers.filter(
    (provider) => provider.availability === "coming_soon" || withAdapter(provider.id) === null,
  );

  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Hosting provider" className="flex flex-col gap-2">
        {available.map((provider) => {
          const connection = connections.find((entry) => entry.providerId === provider.id) ?? null;
          const adapter = withAdapter(provider.id);
          const selected = provider.id === activeProviderId;

          return (
            <button
              key={provider.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onSelect(provider.id)}
              className={`w-full rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                selected
                  ? "border-gray-900 bg-gray-900/[0.04] ring-1 ring-gray-900 ring-inset"
                  : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
              }`}
            >
              <div className="flex items-start gap-2.5">
                <span
                  aria-hidden
                  className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border ${
                    selected ? "border-gray-900" : "border-gray-300"
                  }`}
                >
                  {selected ? <span className="h-2 w-2 rounded-full bg-gray-900" /> : null}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-semibold text-gray-900">{provider.name}</span>
                    {provider.tag ? (
                      <Tag tone={provider.tag === "Recommended" ? "sky" : "gray"}>
                        {provider.tag}
                      </Tag>
                    ) : null}
                  </div>

                  <p className="mt-1 text-xs leading-relaxed text-gray-500">
                    {provider.description}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <ConnectionStateBadge state={connection?.state ?? "not_connected"} size="sm" />
                    {connection?.accountLabel ? (
                      <span className="truncate text-[11px] text-gray-500">
                        {connection.accountLabel}
                      </span>
                    ) : null}
                  </div>

                  {selected && adapter ? (
                    <div className="mt-2 border-t border-gray-100 pt-2">
                      <p className="text-[11px] text-gray-500">
                        Adapter:{" "}
                        <span className="font-medium text-gray-700">{adapter.adapterLabel}</span>
                      </p>
                      <CapabilityTags capabilities={adapter.capabilities} />
                      <p className="mt-1.5 text-[11px] text-gray-500">
                        <span className="font-medium text-gray-600">Simulated CLI:</span>{" "}
                        <span className="font-mono">{provider.cliHint}</span>
                      </p>
                      <p className="mt-1.5 text-[11px] text-gray-500">
                        <span className="font-medium text-gray-600">
                          A real integration needs:
                        </span>{" "}
                        {provider.requirement}
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {upcoming.length > 0 ? (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Future providers (no adapter yet)
          </p>
          <ul className="flex flex-col gap-1.5">
            {upcoming.map((provider) => (
              <li
                key={provider.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-gray-200 px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-gray-500">
                    {provider.name}
                  </span>
                  <span className="block truncate text-[11px] text-gray-400">
                    {provider.description}
                  </span>
                </span>
                <Tag tone="gray">Coming soon</Tag>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
