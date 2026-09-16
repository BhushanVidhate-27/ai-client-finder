"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

interface CampaignSummaryItem {
  id: string;
  niche: string;
  location: string;
  requestedLeadCount: number;
  status: string;
  leadCount: number;
  createdAt: string;
  updatedAt: string;
}

interface LeadItem {
  leadId: string;
  placeId: string;
  businessName: string;
  address: string;
  qualified: boolean;
  score: number;
  hasContact: boolean;
  websiteVersions: number;
  latestWebsiteVersion: number | null;
  existing: boolean;
}

interface CampaignLeadView {
  leadId: string;
  placeId: string;
  businessName: string;
  address: string;
  qualification?: {
    opportunityScore?: number;
    qualified?: boolean;
    qualificationStatus?: string;
    websiteOpportunity?: "NO_WEBSITE" | "NEEDS_REDESIGN" | "GOOD_WEBSITE" | "UNKNOWN" | null;
  } | null;
  contactDiscovery?: { contactMethod?: string } | null;
  duplicateInfo?: {
    websiteVersions?: number;
    latestWebsiteVersion?: number | null;
  } | null;
  existing?: boolean;
}

interface WebsiteVersionItem {
  projectId: string;
  leadId: string;
  version: number;
  status: string;
  isCurrent: boolean;
  createdAt: string;
  buildStatus?: string | null;
  qaStatus?: string | null;
  artifactHash?: string | null;
}

interface JobItem {
  id: string;
  type: string;
  status: string;
  progress: number;
  error: string | null;
  createdAt: string;
}

interface ActivityItem {
  id: string;
  action: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface CampaignDetailResponse {
  campaign: CampaignSummaryItem;
  leads: LeadItem[];
  activity: ActivityItem[];
}

interface DeploymentItem {
  id: string;
  websiteProjectId: string;
  leadId: string;
  websiteVersionId: string;
  version: number;
  provider: string;
  status: string;
  providerDeploymentId: string | null;
  deploymentUrl: string | null;
  jobId: string | null;
  artifactHash: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LeadDetailResponse {
  lead: {
    leadId: string;
    placeId: string;
    businessName: string;
    address: string;
    googleMapsUrl: string;
    websiteUrl?: string;
    qualification: {
      opportunityScore: number;
      qualified: boolean;
      reason: string;
      qualificationStatus: string;
      websiteOpportunity?: "NO_WEBSITE" | "NEEDS_REDESIGN" | "GOOD_WEBSITE" | "UNKNOWN" | null;
    } | null;
    contactDiscovery: {
      email: string | null;
      phone: string | null;
      contactMethod: string;
    } | null;
  };
  research: unknown;
  researchUpdatedAt: string | null;
  websiteVersions: WebsiteVersionItem[];
  jobs: JobItem[];
  activity: ActivityItem[];
  campaignIds: string[];
  deployments: DeploymentItem[];
  outreachDrafts: OutreachDraftItem[];
  outreachApprovals: OutreachApprovalItem[];
  outreachOptOut: OutreachOptOutItem | null;
  outreachSends: OutreachSendItem[];
}

interface OutreachDraftItem {
  id: string;
  leadId: string;
  subject: string | null;
  body: string;
  contentHash: string;
  status: string;
  websiteVersionId: string | null;
  websiteUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OutreachApprovalItem {
  id: string;
  leadId: string;
  draftId: string;
  recipientEmail: string;
  draftHash: string;
  status: string;
  createdBy: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OutreachOptOutItem {
  leadId: string;
  signal: string;
  source: string;
  createdAt: string;
}

interface OutreachSendItem {
  id: string;
  leadId: string;
  draftId: string;
  recipientEmail: string;
  draftHash: string;
  idempotencyKey: string;
  decision: string;
  status: string;
  websiteVersionId: string | null;
  deploymentUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

function fromCampaignLeadView(view: CampaignLeadView): LeadItem {
  const qualification = view.qualification ?? null;
  return {
    leadId: view.leadId,
    placeId: view.placeId,
    businessName: view.businessName,
    address: view.address,
    qualified: qualification?.qualified ?? false,
    score: qualification?.opportunityScore ?? 0,
    hasContact:
      qualification?.qualificationStatus === "available" &&
      Boolean(view.contactDiscovery?.contactMethod),
    websiteVersions: view.duplicateInfo?.websiteVersions ?? 0,
    latestWebsiteVersion: view.duplicateInfo?.latestWebsiteVersion ?? null,
    existing: Boolean(view.existing),
  };
}

function fromJobRow(job: {
  id: string;
  type: string;
  status: string;
  progress: number;
  error: string | null;
  createdAt: string;
}): JobItem {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    error: job.error,
    createdAt: job.createdAt,
  };
}

function fromActivityRow(activity: {
  id: string;
  action: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}): ActivityItem {
  return {
    id: activity.id,
    action: activity.action,
    metadata: activity.metadata,
    createdAt: activity.createdAt,
  };
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function statusClass(status: string): string {
  switch (status) {
    case "completed":
      return "text-green-700 bg-green-50";
    case "running":
      return "text-blue-700 bg-blue-50";
    case "paused":
      return "text-amber-700 bg-amber-50";
    case "stopped":
    case "stopping":
      return "text-red-700 bg-red-50";
    default:
      return "text-gray-700 bg-gray-100";
  }
}

function versionStatusClass(
  kind: "build" | "qa" | "version",
  status: string | null | undefined,
): string {
  const value = status ?? "pending";
  switch (value) {
    case "success":
    case "pass":
      return "text-green-700 bg-green-50";
    case "current":
    case "ready":
      return "text-blue-700 bg-blue-50";
    case "failed":
    case "fail":
      return "text-red-700 bg-red-50";
    case "stopped":
      return "text-red-700 bg-red-50";
    case "pending":
      return "text-gray-600 bg-gray-100";
    case "building":
    case "qa":
      return "text-amber-700 bg-amber-50";
    default:
      return kind === "version"
        ? "text-gray-700 bg-gray-100"
        : "text-gray-600 bg-gray-100";
  }
}

function mapLeadDetail(data: LeadDetailResponse): LeadDetailResponse {
  return {
    lead: {
      leadId: data.lead.leadId,
      placeId: data.lead.placeId,
      businessName: data.lead.businessName,
      address: data.lead.address,
      googleMapsUrl: data.lead.googleMapsUrl,
      websiteUrl: data.lead.websiteUrl,
      qualification: data.lead.qualification ?? null,
      contactDiscovery: data.lead.contactDiscovery ?? null,
    },
    research: data.research,
    researchUpdatedAt: data.researchUpdatedAt,
    websiteVersions: data.websiteVersions.map((version) => ({
      projectId: version.projectId,
      leadId: version.leadId,
      version: version.version,
      status: version.status,
      isCurrent: version.isCurrent,
      createdAt: version.createdAt,
      buildStatus: version.buildStatus ?? null,
      qaStatus: version.qaStatus ?? null,
      artifactHash: version.artifactHash ?? null,
    })),
    jobs: data.jobs.map((job) => fromJobRow(job)),
    activity: data.activity.map((item) => fromActivityRow(item)),
    campaignIds: data.campaignIds,
    deployments: data.deployments,
    outreachDrafts: data.outreachDrafts,
    outreachApprovals: data.outreachApprovals,
    outreachOptOut: data.outreachOptOut ?? null,
    outreachSends: data.outreachSends,
  };
}

export default function HistoryClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const leadParam = searchParams.get("lead");
  const [campaigns, setCampaigns] = useState<CampaignSummaryItem[]>([]);
  const [campaignDetail, setCampaignDetail] =
    useState<CampaignDetailResponse | null>(null);
  const [leadDetail, setLeadDetail] = useState<LeadDetailResponse | null>(null);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(Boolean(leadParam));
  const [error, setError] = useState<string | null>(null);

  const loadCampaigns = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/history/campaigns");
      if (!response.ok) {
        throw new Error("Failed to load campaigns.");
      }
      const data = (await response.json()) as {
        campaigns: CampaignSummaryItem[];
      };
      setCampaigns(data.campaigns);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Load failed.");
    } finally {
      setLoadingCampaigns(false);
    }
  }, []);

  const loadCampaign = useCallback(async (id: string) => {
    setLoadingDetail(true);
    setLeadDetail(null);
    setError(null);
    try {
      const response = await fetch(`/api/admin/history/campaigns/${id}`);
      if (!response.ok) {
        throw new Error("Failed to load campaign.");
      }
      const data = (await response.json()) as CampaignDetailResponse;
      setCampaignDetail({
        campaign: data.campaign,
        leads: data.leads.map((lead) => fromCampaignLeadView(lead)),
        activity: data.activity.map((item) => fromActivityRow(item)),
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Load failed.");
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const loadLead = useCallback(async (id: string) => {
    setLoadingDetail(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/history/leads/${id}`);
      if (!response.ok) {
        throw new Error("Failed to load lead.");
      }
      const data = (await response.json()) as LeadDetailResponse;
      setLeadDetail(mapLeadDetail(data));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Load failed.");
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/admin/history/campaigns");
        if (cancelled) return;
        if (!response.ok) {
          throw new Error("Failed to load campaigns.");
        }
        const data = (await response.json()) as {
          campaigns: CampaignSummaryItem[];
        };
        setCampaigns(data.campaigns);
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : "Load failed.",
          );
        }
      } finally {
        if (!cancelled) setLoadingCampaigns(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!leadParam) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/admin/history/leads/${leadParam}`);
        if (cancelled) return;
        if (!response.ok) {
          throw new Error("Failed to load lead.");
        }
        const data = (await response.json()) as LeadDetailResponse;
        setLeadDetail(mapLeadDetail(data));
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : "Load failed.",
          );
        }
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [leadParam]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
          <h1 className="text-lg font-semibold text-gray-900">
            Campaign &amp; Lead History
          </h1>
          <div className="flex items-center gap-3 text-sm">
            <Link
              href="/"
              className="font-medium text-blue-600 hover:text-blue-800"
            >
              Back to home
            </Link>
            <button
              onClick={() => {
                void loadCampaigns();
              }}
              className="rounded-md border border-gray-300 px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-50"
            >
              Refresh
            </button>
            <button
              onClick={() => {
                router.push("/api/auth/logout");
              }}
              className="rounded-md bg-gray-900 px-3 py-1.5 font-medium text-gray-100 hover:bg-gray-700"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[300px_1fr]">
        <aside className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Campaigns ({campaigns.length})
          </h2>
          {loadingCampaigns ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : campaigns.length === 0 ? (
            <p className="text-sm text-gray-500">
              No campaigns yet. Run a discovery from the home page.
            </p>
          ) : (
            <ul className="space-y-2">
              {campaigns.map((campaign) => (
                <li key={campaign.id}>
                  <button
                    onClick={() => {
                      void loadCampaign(campaign.id);
                    }}
                    className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                      campaignDetail?.campaign.id !== campaign.id
                        ? "border-transparent hover:bg-gray-50"
                        : "border-blue-200 bg-blue-50"
                    }`}
                  >
                    <div className="text-sm font-medium text-gray-900">
                      {campaign.niche}
                    </div>
                    <div className="text-xs text-gray-500">
                      {campaign.location} · {campaign.leadCount} lead
                      {campaign.leadCount === 1 ? "" : "s"} · {campaign.status}
                    </div>
                    <div className="text-xs text-gray-400">
                      {formatDate(campaign.createdAt)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="rounded-lg border border-gray-200 bg-white p-4">
          {error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : loadingDetail ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : leadDetail ? (
            <LeadDetailPane
              lead={leadDetail.lead}
              research={leadDetail.research}
              researchUpdatedAt={leadDetail.researchUpdatedAt}
              websiteVersions={leadDetail.websiteVersions}
              jobs={leadDetail.jobs}
              activity={leadDetail.activity}
              campaignIds={leadDetail.campaignIds}
              deployments={leadDetail.deployments}
              outreachDrafts={leadDetail.outreachDrafts}
              outreachApprovals={leadDetail.outreachApprovals}
              outreachOptOut={leadDetail.outreachOptOut}
              outreachSends={leadDetail.outreachSends}
            />
          ) : campaignDetail ? (
            <CampaignDetailPane
              campaign={campaignDetail.campaign}
              leads={campaignDetail.leads}
              activity={campaignDetail.activity}
              onSelectLead={(id) => {
                void loadLead(id);
              }}
            />
          ) : (
            <div className="py-12 text-center">
              <p className="text-gray-500">
                Select a campaign to view its leads and activity, or open a
                specific lead from a duplicate notice.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function CampaignDetailPane({
  campaign,
  leads,
  activity,
  onSelectLead,
}: {
  campaign: CampaignSummaryItem;
  leads: LeadItem[];
  activity: ActivityItem[];
  onSelectLead: (id: string) => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">
          {campaign.niche} in {campaign.location}
        </h2>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span
            className={`rounded-full px-2 py-0.5 font-medium ${statusClass(
              campaign.status,
            )}`}
          >
            {campaign.status}
          </span>
          <span>
            Requested: {campaign.requestedLeadCount} · Found: {leads.length}
          </span>
          <span>Created: {formatDate(campaign.createdAt)}</span>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Leads ({leads.length})
        </h3>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-2 py-2">Business</th>
                <th className="px-2 py-2">Score</th>
                <th className="px-2 py-2">Contact</th>
                <th className="px-2 py-2">Versions</th>
                <th className="px-2 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {leads.map((lead) => (
                <tr key={lead.leadId} className="hover:bg-gray-50">
                  <td className="px-2 py-2">
                    <button
                      onClick={() => onSelectLead(lead.leadId)}
                      className="text-left font-medium text-blue-600 hover:text-blue-800"
                    >
                      {lead.businessName}
                    </button>
                    <div className="text-xs text-gray-500">{lead.address}</div>
                  </td>
                  <td className="px-2 py-2 font-medium">{lead.score}</td>
                  <td className="px-2 py-2">{lead.hasContact ? "Yes" : "No"}</td>
                  <td className="px-2 py-2">
                    {lead.websiteVersions > 0
                      ? lead.websiteVersions.toString()
                      : "—"}
                  </td>
                  <td className="px-2 py-2">
                    {lead.existing ? (
                      <span className="rounded-full bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700">
                        Existing
                      </span>
                    ) : lead.qualified ? (
                      <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                        Qualified
                      </span>
                    ) : (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                        Not qualified
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Activity ({activity.length})
        </h3>
        {activity.length === 0 ? (
          <p className="text-sm text-gray-500">No activity recorded.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {activity.map((item) => (
              <li key={item.id} className="flex items-baseline gap-3">
                <span className="w-40 shrink-0 text-xs text-gray-400">
                  {formatDate(item.createdAt)}
                </span>
                <span className="font-medium text-gray-800">{item.action}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function LeadDetailPane({
  lead,
  research,
  researchUpdatedAt,
  websiteVersions,
  jobs,
  activity,
  campaignIds,
  deployments,
  outreachDrafts,
  outreachApprovals,
  outreachOptOut,
  outreachSends,
}: {
  lead: LeadDetailResponse["lead"];
  research: unknown;
  researchUpdatedAt: string | null;
  websiteVersions: WebsiteVersionItem[];
  jobs: JobItem[];
  activity: ActivityItem[];
  campaignIds: string[];
  deployments: DeploymentItem[];
  outreachDrafts: OutreachDraftItem[];
  outreachApprovals: OutreachApprovalItem[];
  outreachOptOut: OutreachOptOutItem | null;
  outreachSends: OutreachSendItem[];
}) {
  const qualification = lead.qualification;
  const contact = lead.contactDiscovery;
  const currentVersion = websiteVersions.find(
    (version) => version.isCurrent,
  )?.version ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            {lead.businessName}
          </h2>
          <div className="mt-1 text-sm text-gray-500">{lead.address}</div>
          <div className="mt-0.5 text-xs text-gray-400">Place ID: {lead.placeId}</div>
        </div>
        <div className="flex gap-2 text-sm">
          <a
            href={lead.googleMapsUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-gray-300 px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-50"
          >
            Google Maps
          </a>
          {lead.websiteUrl ? (
            <a
              href={lead.websiteUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-gray-300 px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-50"
            >
              Website
            </a>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-md border border-gray-200 p-3">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Qualification
          </h3>
          {qualification ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Score</dt>
                <dd className="font-medium">{qualification.opportunityScore}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Qualified</dt>
                <dd>{qualification.qualified ? "Yes" : "No"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Status</dt>
                <dd>{qualification.qualificationStatus}</dd>
              </div>
              {qualification.websiteOpportunity && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">Website</dt>
                  <dd>
                    {({
                      NO_WEBSITE: "No website",
                      NEEDS_REDESIGN: "Needs redesign",
                      GOOD_WEBSITE: "Good website",
                      UNKNOWN: "Unknown",
                    })[qualification.websiteOpportunity]}
                  </dd>
                </div>
              )}
              <p className="pt-1 text-xs text-gray-600">{qualification.reason}</p>
            </dl>
          ) : (
            <p className="text-sm text-gray-500">Not qualified.</p>
          )}
        </section>

        <section className="rounded-md border border-gray-200 p-3">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Contact Discovery
          </h3>
          {contact ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Email</dt>
                <dd className="font-medium">{contact.email ?? "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Phone</dt>
                <dd className="font-medium">{contact.phone ?? "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Method</dt>
                <dd className="font-medium">{contact.contactMethod}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-gray-500">No contact data.</p>
          )}
        </section>
      </div>

      <section className="rounded-md border border-gray-200 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Website Versions ({websiteVersions.length})
          </h3>
          <span className="text-xs text-gray-400">
            {currentVersion ? `Current version: v${currentVersion}` : "No current version yet"}
            {campaignIds.length > 0
              ? ` · In campaigns: ${campaignIds.join(", ")}`
              : ""}
          </span>
        </div>
        {websiteVersions.length === 0 ? (
          <p className="text-sm text-gray-500">
            No website versions generated yet.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {websiteVersions.map((version) => (
              <li
                key={version.projectId}
                className="flex items-center justify-between gap-2 py-2"
              >
                <span className="min-w-0">
                  <span className="font-medium text-gray-900">
                    Version {version.version}
                  </span>{" "}
                  <span className="text-xs text-gray-400">
                    · {formatDate(version.createdAt)}
                  </span>
                  {version.buildStatus || version.qaStatus ? (
                    <span className="flex flex-wrap gap-1 pt-1">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${versionStatusClass(
                          "build",
                          version.buildStatus,
                        )}`}
                      >
                        build: {version.buildStatus ?? "pending"}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${versionStatusClass(
                          "qa",
                          version.qaStatus,
                        )}`}
                      >
                        qa: {version.qaStatus ?? "pending"}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${versionStatusClass(
                          "version",
                          version.status,
                        )}`}
                      >
                        {version.status}
                      </span>
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {version.isCurrent ? (
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                      Current
                    </span>
                  ) : null}
                  <Link
                    href={`/preview/${version.projectId}`}
                    className="font-medium text-blue-600 hover:text-blue-800"
                  >
                    Preview
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        )}
        {researchUpdatedAt ? (
          <p className="mt-2 text-xs text-gray-400">
            Research last updated: {formatDate(researchUpdatedAt)}
          </p>
        ) : null}
        {research ? <ResearchSummary research={research} /> : null}
      </section>

      <DeploymentSection
        leadId={lead.leadId}
        deployments={deployments}
        hasCurrentVerifiedVersion={
          websiteVersions.some(
            (version) =>
              version.isCurrent &&
              version.buildStatus === "success" &&
              version.qaStatus === "pass",
          )
        }
      />

      <OutreachSafetySection
        leadId={lead.leadId}
        contactEmail={lead.contactDiscovery?.email ?? null}
        drafts={outreachDrafts}
        approvals={outreachApprovals}
        optOut={outreachOptOut}
        sends={outreachSends}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-md border border-gray-200 p-3">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Jobs ({jobs.length})
          </h3>
          {jobs.length === 0 ? (
            <p className="text-sm text-gray-500">No jobs for this lead.</p>
          ) : (
            <ul className="divide-y divide-gray-100 text-sm">
              {jobs.map((job) => (
                <li key={job.id} className="flex items-center justify-between py-2">
                  <div>
                    <div className="font-medium text-gray-800">{job.type}</div>
                    <div className="text-xs text-gray-400">
                      {formatDate(job.createdAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">
                      {job.progress}%
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(
                        job.status,
                      )}`}
                    >
                      {job.status}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-md border border-gray-200 p-3">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Timeline ({activity.length})
          </h3>
          {activity.length === 0 ? (
            <p className="text-sm text-gray-500">No activity recorded.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {activity.map((item) => (
                <li key={item.id} className="flex items-baseline gap-3">
                  <span className="w-40 shrink-0 text-xs text-gray-400">
                    {formatDate(item.createdAt)}
                  </span>
                  <span className="font-medium text-gray-800">{item.action}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function deploymentStatusClass(status: string): string {
  switch (status) {
    case "ready":
      return "text-green-700 bg-green-50";
    case "failed":
      return "text-red-700 bg-red-50";
    case "cancelled":
      return "text-gray-600 bg-gray-100";
    case "deploying":
    case "building":
      return "text-blue-700 bg-blue-50";
    case "pending":
    case "validating":
    case "uploading":
      return "text-amber-700 bg-amber-50";
    default:
      return "text-gray-700 bg-gray-100";
  }
}

const ACTIVE_DEPLOYMENT_STATUSES = [
  "pending",
  "validating",
  "uploading",
  "building",
  "deploying",
];

function DeploymentSection({
  leadId,
  deployments,
  hasCurrentVerifiedVersion,
}: {
  leadId: string;
  deployments: DeploymentItem[];
  hasCurrentVerifiedVersion: boolean;
}) {
  const [providers, setProviders] = useState<
    Array<{ id: string; label: string; state: string; supportsCancel: boolean; isMock?: boolean }>
  >([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const activeCount = deployments.filter((d) =>
    ACTIVE_DEPLOYMENT_STATUSES.includes(d.status),
  ).length;

  useEffect(() => {
    let cancelled = false;
    const loadProviders = async () => {
      try {
        const response = await fetch("/api/admin/deployment/providers");
        if (cancelled) return;
        if (!response.ok) return;
        const data = (await response.json()) as {
          providers: Array<{ id: string; label: string; state: string; supportsCancel: boolean; isMock?: boolean }>;
        };
        setProviders(data.providers);
        setSelectedProvider((previous) => {
          if (previous) return previous;
          const configured =
            data.providers.find((p) => p.state === "connected") ??
            data.providers.find((p) => !p.isMock) ??
            data.providers[0];
          return configured?.id ?? "";
        });
      } catch {
        // Providers are non-critical; the deploy call will surface errors.
      }
    };
    void loadProviders();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll for completion while a deployment is active.
  useEffect(() => {
    if (activeCount === 0) return;
    const timer = window.setInterval(() => {
      window.location.reload();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [activeCount]);

  const deploy = async () => {
    if (!selectedProvider) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/admin/website-projects/${encodeURIComponent(leadId)}/deployments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: selectedProvider }),
        },
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setNotice(data.error ?? "Deploy failed.");
      } else {
        window.location.reload();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Deploy failed.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (deploymentId: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await fetch(
        `/api/admin/website-projects/${encodeURIComponent(leadId)}/deployments/${deploymentId}/cancel`,
        { method: "POST" },
      );
      window.location.reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Cancel failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-md border border-gray-200 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Deployments ({deployments.length})
        </h3>
        <div className="flex items-center gap-2 text-sm">
          <select
            value={selectedProvider}
            onChange={(event) => setSelectedProvider(event.target.value)}
            disabled={busy}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-700"
          >
            {providers.length === 0 ? (
              <option value="">No providers</option>
            ) : (
              providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label} ({provider.state})
                </option>
              ))
            )}
          </select>
          <button
            onClick={() => void deploy()}
            disabled={busy || activeCount > 0 || !selectedProvider || !hasCurrentVerifiedVersion}
            className="rounded-md bg-gray-900 px-3 py-1.5 font-medium text-gray-100 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            title={
              hasCurrentVerifiedVersion
                ? undefined
                : "A verified current version is required first."
            }
          >
            Deploy
          </button>
        </div>
      </div>

      {notice ? <p className="mb-2 text-sm text-red-600">{notice}</p> : null}
      {!hasCurrentVerifiedVersion ? (
        <p className="mb-2 text-xs text-gray-500">
          Deployment requires a current version with a passing build and QA.
        </p>
      ) : null}

      {deployments.length === 0 ? (
        <p className="text-sm text-gray-500">No deployments for this lead yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100 text-sm">
          {deployments.map((deployment) => (
            <li
              key={deployment.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="min-w-0">
                <span className="font-medium text-gray-900">
                  {deployment.provider} · v{deployment.version}
                </span>{" "}
                <span className="text-xs text-gray-400">
                  · {formatDate(deployment.createdAt)}
                </span>
                <span className="flex flex-wrap gap-1 pt-1">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${deploymentStatusClass(
                      deployment.status,
                    )}`}
                  >
                    {deployment.status}
                  </span>
                  {deployment.deploymentUrl ? (
                    <a
                      href={deployment.deploymentUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
                    >
                      Open URL
                    </a>
                  ) : null}
                </span>
                {deployment.failureReason ? (
                  <span className="mt-1 block text-xs text-red-600">
                    {deployment.failureReason}
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {ACTIVE_DEPLOYMENT_STATUSES.includes(deployment.status) ? (
                  <button
                    onClick={() => void cancel(deployment.id)}
                    disabled={busy}
                    className="rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                ) : null}
                {deployment.providerDeploymentId ? (
                  <span className="max-w-[180px] truncate text-xs text-gray-400">
                    {deployment.providerDeploymentId}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OutreachSafetySection({
  leadId,
  contactEmail,
  drafts,
  approvals,
  optOut,
  sends,
}: {
  leadId: string;
  contactEmail: string | null;
  drafts: OutreachDraftItem[];
  approvals: OutreachApprovalItem[];
  optOut: OutreachOptOutItem | null;
  sends: OutreachSendItem[];
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const latestDraft = drafts[0] ?? null;
  const hasApproval =
    approvals.length > 0 && approvals[0].status === "valid";

  const approve = async (draftId: string) => {
    setBusy(true);
    setNotice(null);
    try {
      if (!contactEmail) {
        setNotice("No verified contact email is available.");
        return;
      }
      const response = await fetch(
        "/api/admin/outreach/safety/approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            leadId,
            draftId,
            recipientEmail: contactEmail,
          }),
        },
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setNotice(data.error ?? "Approval failed.");
      } else {
        window.location.reload();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Approval failed.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (draftId: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(
        "/api/admin/outreach/safety/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draftId }),
        },
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setNotice(data.error ?? "Revoke failed.");
      } else {
        window.location.reload();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Revoke failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-md border border-gray-200 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Outreach Safety
        </h3>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              optOut
                ? "bg-red-50 text-red-700"
                : drafts.length === 0
                  ? "bg-gray-100 text-gray-600"
                  : hasApproval
                    ? "bg-green-50 text-green-700"
                    : "bg-amber-50 text-amber-700"
            }`}
          >
            {optOut
              ? "Opted out"
              : drafts.length === 0
                ? "No draft"
                : hasApproval
                  ? "Approved"
                  : "Needs approval"}
          </span>
        </div>
      </div>

      {notice ? <p className="mb-2 text-sm text-red-600">{notice}</p> : null}

      {optOut ? (
        <p className="mb-2 text-xs text-red-700">
          This prospect has opted out ({optOut.signal}). Outreach is blocked.
        </p>
      ) : null}

      <div className="space-y-2 text-sm">
        <div>
          <span className="font-medium text-gray-700">Recipient: </span>
          {contactEmail ? (
            <span className="text-gray-800">{contactEmail} (verified)</span>
          ) : (
            <span className="text-red-600">No verified email</span>
          )}
        </div>

        {latestDraft ? (
          <div className="rounded-md bg-gray-50 p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium text-gray-900">
                  {latestDraft.subject ?? "(no subject)"}
                </div>
                <div className="flex flex-wrap gap-1 pt-1">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      latestDraft.status === "eligible"
                        ? "bg-green-50 text-green-700"
                        : latestDraft.status === "blocked"
                          ? "bg-red-50 text-red-700"
                          : "bg-amber-50 text-amber-700"
                    }`}
                  >
                    {latestDraft.status}
                  </span>
                  <span className="max-w-[200px] truncate rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                    {latestDraft.contentHash.slice(0, 12)}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                {latestDraft.status === "eligible" && !optOut ? (
                  hasApproval ? (
                    <button
                      onClick={() => void revoke(latestDraft.id)}
                      disabled={busy}
                      className="rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  ) : (
                    <button
                      onClick={() => void approve(latestDraft.id)}
                      disabled={busy || !contactEmail}
                      className="rounded-md bg-gray-900 px-3 py-1 text-xs font-medium text-gray-100 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Approve
                    </button>
                  )
                ) : null}
              </div>
            </div>
            <div className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-gray-600">
              {latestDraft.body}
            </div>
          </div>
        ) : (
          <p className="text-gray-500">No outreach drafts for this lead.</p>
        )}

        {drafts.length > 1 ? (
          <p className="text-xs text-gray-400">
            {drafts.length} drafts total; showing the latest.
          </p>
        ) : null}

        {sends.length > 0 ? (
          <div>
            <span className="font-medium text-gray-700">Send authorizations: </span>
            <span className="text-gray-600">{sends.length}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ResearchSummary({ research }: { research: unknown }) {
  const record =
    research && typeof research === "object"
      ? (research as Record<string, unknown>)
      : null;
  const title =
    record && typeof record.title === "string" ? record.title : null;
  const tagline =
    record && typeof record.tagline === "string" ? record.tagline : null;

  return (
    <div className="mt-3 rounded-md bg-gray-50 p-3 text-sm text-gray-700">
      {title ? (
        <div className="font-semibold text-gray-900">{title}</div>
      ) : null}
      {tagline ? <div className="mt-1 italic">{tagline}</div> : null}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-gray-500">
          View research data
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-white p-2 text-xs text-gray-600">
          {JSON.stringify(record, null, 2)}
        </pre>
      </details>
    </div>
  );
}