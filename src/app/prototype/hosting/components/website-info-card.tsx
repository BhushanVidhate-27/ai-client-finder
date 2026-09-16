import type { DeploymentRecord, DeploymentStatus, WebsiteInfo } from "../types";
import { formatDateTime, formatHost, formatRelativeTime, formatVersion } from "../lib/format";
import { ActivityDot, VersionBadge } from "./status-badge";
import { InfoRow } from "./panel";
import { MockUrl } from "./mock-url";
import { isActiveStatus } from "../lib/status";

export interface WebsiteInfoCardProps {
  website: WebsiteInfo | null;
  providerName: string;
  status: DeploymentStatus;
  /** The version currently serving traffic, if any. */
  liveRecord: DeploymentRecord | null;
}

export function WebsiteInfoCard({
  website,
  providerName,
  status,
  liveRecord,
}: WebsiteInfoCardProps) {
  if (!website) {
    return <p className="text-xs text-gray-500">Loading website details…</p>;
  }

  const latestAttemptIsNewerThanLive =
    liveRecord !== null &&
    website.version !== liveRecord.version;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-900">{website.businessName}</p>
          <p className="text-xs text-gray-500">
            Generated website · {formatVersion(website.version)}
          </p>
        </div>
        <VersionBadge version={website.version} isCurrent={status === "live"} />
      </div>

      {latestAttemptIsNewerThanLive ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 ring-1 ring-amber-200 ring-inset">
          {formatVersion(website.version)} is not published. {formatVersion(liveRecord.version)} is
          still the version serving visitors.
        </p>
      ) : null}

      <dl>
        <InfoRow label="Business name">{website.businessName}</InfoRow>
        <InfoRow label="Website version">
          <span className="inline-flex items-center gap-2">
            {formatVersion(website.version)}
            {status === "live" ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
                <ActivityDot className="text-emerald-500" /> serving
              </span>
            ) : null}
          </span>
        </InfoRow>
        <InfoRow label="Project ID" mono>
          {website.projectId}
        </InfoRow>
        <InfoRow label="Last deployment">
          {website.lastDeployedAt
            ? `${formatRelativeTime(website.lastDeployedAt)} · ${formatDateTime(website.lastDeployedAt)}`
            : "Never deployed"}
        </InfoRow>
        <InfoRow label="Public URL">
          <MockUrl url={website.publicUrl} />
        </InfoRow>
        <InfoRow label="Target provider">{providerName}</InfoRow>
        <InfoRow label="Build command" mono>
          {website.buildCommand}
        </InfoRow>
        <InfoRow label="Output directory" mono>
          {website.outputDirectory}
        </InfoRow>
        <InfoRow label="Source website">
          <span className="font-mono text-xs">
            {website.leadId} · {website.campaignId}
          </span>
        </InfoRow>
      </dl>

      {liveRecord?.publicUrl ? (
        <p className="text-[11px] text-gray-500">
          Live host: {formatHost(liveRecord.publicUrl)} — shown as text only; the prototype never
          contacts it. Addresses use the reserved <code>.example.test</code> domain, so they cannot
          resolve. Use &ldquo;View Live Site&rdquo; to open the placeholder yourself.
        </p>
      ) : null}

      {isActiveStatus(status) ? (
        <p className="text-[11px] text-gray-500">
          Details refresh when the simulated run finishes.
        </p>
      ) : null}
    </div>
  );
}
