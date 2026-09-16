"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface ContactDiscovery {
  email: string | null;
  emailType: "business" | "professional" | "unknown" | null;
  emailSourceUrl: string | null;
  emailConfidence: "high" | "medium" | "low" | null;
  emailStatus: "found" | "not_found" | "needs_review";
  phone: string | null;
  phoneSourceUrl: string | null;
  contactMethod: "email" | "phone" | "none";
  discoveryPath: "website" | "no_website";
}

interface DuplicateInfo {
  firstSeenCampaignId: string | null;
  firstSeenAt: string;
  websiteVersions: number;
  latestWebsiteVersion: number | null;
  lastGeneratedAt: string | null;
  lastResearchedAt: string | null;
}

interface Lead {
  leadId: string;
  placeId: string;
  businessName: string;
  address: string;
  googleMapsUrl: string;
  websiteUrl: string | undefined;
  internationalPhoneNumber: string | undefined;
  nationalPhoneNumber: string | undefined;
  rating: number | undefined;
  reviewCount: number | undefined;
  businessStatus: string | undefined;
  primaryType: string | undefined;
  types: string[] | undefined;
  qualification: {
    opportunityScore: number;
    qualified: boolean;
    reason: string;
    websiteAssessment: string;
    qualificationStatus: "complete" | "unavailable";
    websiteOpportunity?: "NO_WEBSITE" | "NEEDS_REDESIGN" | "GOOD_WEBSITE" | "UNKNOWN" | null;
    websiteEvidence?: string[];
  };
  contactDiscovery?: ContactDiscovery | null;
  research?: LeadResearch;
  website?: LeadWebsite;
  existing?: boolean;
  duplicateInfo?: DuplicateInfo | null;
}

interface WebsiteResearch {
  businessSummary: string;
  services: string[];
  targetAudience: string;
  location: string;
  brandObservations: string[];
  existingWebsiteAssessment: string;
  suggestedPages: string[];
  suggestedSections: string[];
  primaryCTA: string;
  copyDirection: string;
  visualDirection: string;
  verifiedFacts: string[];
  unknowns: string[];
  sources: string[];
}

interface LeadResearch {
  status: "idle" | "in_progress" | "complete" | "failed";
  websiteResearch?: WebsiteResearch | null;
  errorMessage?: string | null;
}

interface ResearchResult {
  placeId: string;
  status: "complete" | "failed";
  websiteResearch: WebsiteResearch | null;
  errorMessage: string | null;
}

interface LeadWebsite {
  status: "idle" | "in_progress" | "completed" | "failed";
  projectId?: string;
  errorMessage?: string | null;
}

interface CampaignSummary {
  campaignId: string;
  niche: string;
  location: string;
  numberOfLeads: number;
  status: string;
}

interface AgentJob {
  id: string;
  type: string;
  status: string;
  progress: number;
  currentStep: string | null;
  startedAt: string | null;
  completedAt: string | null;
  stoppedAt: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

const JOB_STATUS_STYLES: Record<string, string> = {
  queued: "bg-gray-100 text-gray-700",
  running: "bg-blue-100 text-blue-700",
  paused: "bg-amber-100 text-amber-700",
  stopping: "bg-orange-100 text-orange-700",
  stopped: "bg-gray-200 text-gray-600",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function SpecSection({
  title,
  body,
  items,
  links,
}: {
  title: string;
  body?: string;
  items?: string[];
  links?: string[];
}) {
  if (body === undefined && items === undefined && links === undefined) return null;
  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-900">{title}</h4>
      {body !== undefined && <p className="mt-1 text-sm text-gray-600">{body}</p>}
      {items !== undefined &&
        (items.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {items.map((item, index) => (
              <li
                key={index}
                className="text-sm text-gray-600 list-disc list-inside"
              >
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-gray-400">None</p>
        ))}
      {links !== undefined &&
        (links.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {links.map((link, index) => (
              <li key={index}>
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:text-blue-800 break-all"
                >
                  {link}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-gray-400">None</p>
        ))}
    </div>
  );
}

export default function AppHome() {
  const router = useRouter();
  const [niche, setNiche] = useState("");
  const [location, setLocation] = useState("");
  const [numberOfLeads, setNumberOfLeads] = useState<number>(50);
  const [summary, setSummary] = useState<CampaignSummary | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDiscoveringContacts, setIsDiscoveringContacts] = useState(false);
  const [isResearching, setIsResearching] = useState(false);
  const [isUpdatingLeadId, setIsUpdatingLeadId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{
    businessName: string;
    research: WebsiteResearch;
  } | null>(null);

  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);

  const qualifiedCount = leads.filter((lead) => lead.qualification?.qualified).length;
  const contactFoundCount = leads.filter(
    (lead) => lead.contactDiscovery?.contactMethod !== "none",
  ).length;
  const briefCount = leads.filter(
    (lead) => lead.research?.status === "complete",
  ).length;

  const fetchJobs = async () => {
    setJobsLoading(true);
    try {
      const response = await fetch("/api/admin/jobs");
      if (response.ok) {
        const data = await response.json();
        setJobs(data.jobs ?? []);
      }
    } catch {
      // Ignore transient fetch failures; the Refresh button retries.
    } finally {
      setJobsLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/admin/jobs");
        if (cancelled) return;
        if (response.ok) {
          const data = (await response.json()) as { jobs: AgentJob[] };
          setJobs(data.jobs ?? []);
        }
      } catch {
        // Ignore initial fetch failures; the Refresh button retries.
      } finally {
        if (!cancelled) setJobsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Ignore; redirect regardless.
    }
    router.push("/login");
    router.refresh();
  };

  const handleJobControl = async (
    job: AgentJob,
    action: "stop" | "pause" | "resume" | "retry",
  ) => {
    setError(null);
    try {
      const response = await fetch(`/api/admin/jobs/${job.id}/${action}`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? `${action} failed.`);
      }
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : `${action} failed.`,
      );
    } finally {
      await fetchJobs();
    }
  };

  const handleDiscoverContacts = async () => {
    if (leads.length === 0) return;
    setError(null);
    setIsDiscoveringContacts(true);

    try {
      const response = await fetch("/api/campaigns/contact-discovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leads }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Contact discovery failed.");
      }

      setLeads(data.leads ?? leads);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Contact discovery failed.",
      );
    } finally {
      setIsDiscoveringContacts(false);
      await fetchJobs();
    }
  };

  const handleResearch = async (leadsToResearch: Lead[]) => {
    if (leadsToResearch.length === 0) return;
    setError(null);
    setIsResearching(true);
    const placeIds = new Set(leadsToResearch.map((lead) => lead.placeId));

    setLeads((prev) =>
      prev.map((lead) =>
        placeIds.has(lead.placeId)
          ? { ...lead, research: { status: "in_progress" } }
          : lead,
      ),
    );

    try {
      const response = await fetch("/api/campaigns/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leads: leadsToResearch }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Research failed.");
      }

      const results: ResearchResult[] = data.results ?? [];
      setLeads((prev) =>
        prev.map((lead) => {
          const result = results.find((r) => r.placeId === lead.placeId);
          if (!result) return lead;
          return {
            ...lead,
            research: {
              status: result.status,
              websiteResearch: result.websiteResearch,
              errorMessage: result.errorMessage,
            },
          };
        }),
      );
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : "Research failed.";
      setLeads((prev) =>
        prev.map((lead) =>
          placeIds.has(lead.placeId)
            ? {
                ...lead,
                research: {
                  status: "failed",
                  websiteResearch: null,
                  errorMessage: message,
                },
              }
            : lead,
        ),
      );
      setError(message);
    } finally {
      setIsResearching(false);
      await fetchJobs();
    }
  };

  const handleResearchAll = () =>
    handleResearch(leads.filter((lead) => lead.qualification?.qualified));

  const handleResearchOne = (lead: Lead) => handleResearch([lead]);

  const handleUpdateLead = async (lead: Lead) => {
    if (isUpdatingLeadId) return;
    setIsUpdatingLeadId(lead.leadId);
    setError(null);
    try {
      const response = await fetch(`/api/admin/leads/${lead.leadId}/update`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Update failed.");
      }
      setLeads((prev) =>
        prev.map((l) =>
          l.leadId === lead.leadId
            ? {
                ...l,
                ...(data.lead ?? {}),
                research: {
                  status: "complete",
                  websiteResearch: data.research ?? l.research?.websiteResearch,
                },
              }
            : l,
        ),
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Update failed.",
      );
    } finally {
      setIsUpdatingLeadId(null);
      await fetchJobs();
    }
  };

  const handleGenerateWebsite = async (lead: Lead) => {
    if (!lead.research?.websiteResearch) return;
    setError(null);
    setLeads((prev) =>
      prev.map((l) =>
        l.placeId === lead.placeId
          ? { ...l, website: { status: "in_progress" } }
          : l,
      ),
    );

    try {
      const response = await fetch("/api/campaigns/website", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead,
          websiteResearch: lead.research.websiteResearch,
        }),
      });
      const data = await response.json();

      setLeads((prev) =>
        prev.map((l) => {
          if (l.placeId !== lead.placeId) return l;
          if (!response.ok) {
            return {
              ...l,
              website: {
                status: "failed",
                errorMessage: data.error ?? "Generation failed.",
              },
            };
          }
          if (data.status === "completed" && data.project?.projectId) {
            return {
              ...l,
              website: {
                status: "completed",
                projectId: data.project.projectId,
                errorMessage: null,
              },
            };
          }
          return {
            ...l,
            website: {
              status: "failed",
              errorMessage: data.errorMessage ?? "Generation failed.",
            },
          };
        }),
      );
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Generation failed.";
      setLeads((prev) =>
        prev.map((l) =>
          l.placeId === lead.placeId
            ? { ...l, website: { status: "failed", errorMessage: message } }
            : l,
        ),
      );
      setError(message);
    } finally {
      await fetchJobs();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSummary(null);
    setLeads([]);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ niche, location, leadCount: numberOfLeads }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Unable to create campaign.");
      }

      setSummary({
        campaignId: data.campaign.id,
        niche: data.campaign.niche,
        location: data.campaign.location,
        numberOfLeads: data.campaign.leadCount,
        status: data.campaign.status,
      });
      setLeads(data.leads ?? []);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to create campaign.",
      );
    } finally {
      setIsSubmitting(false);
      await fetchJobs();
    }
  };

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">AI Client Finder</h1>
            <p className="mt-1 text-sm text-gray-500">
              Find and connect with potential clients for your business
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <a
              href="/agents"
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-50 rounded-lg hover:bg-gray-100 border border-gray-200 transition-colors"
            >
              Agents
            </a>
            <a
              href="/history"
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-50 rounded-lg hover:bg-gray-100 border border-gray-200 transition-colors"
            >
              History
            </a>
            <button
              onClick={handleLogout}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900"
            >
              Log out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Campaign Form */}
          <div className="lg:col-span-1 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">
              Create New Campaign
            </h2>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label
                  htmlFor="niche"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
                  Niche
                </label>
                <input
                  type="text"
                  id="niche"
                  value={niche}
                  onChange={(e) => setNiche(e.target.value)}
                  placeholder="e.g. Photographer"
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-colors"
                />
              </div>

              <div>
                <label
                  htmlFor="location"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
                  Location
                </label>
                <input
                  type="text"
                  id="location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. United States"
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-colors"
                />
              </div>

              <div>
                <label
                  htmlFor="numberOfLeads"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
                  Number of leads
                </label>
                <input
                  type="number"
                  id="numberOfLeads"
                  value={numberOfLeads}
                  onChange={(e) => setNumberOfLeads(e.target.valueAsNumber)}
                  min={1}
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-colors"
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg font-medium hover:bg-blue-700 disabled:bg-blue-400 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
              >
                {isSubmitting ? "Searching..." : "Find Clients"}
              </button>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </form>

            {/* Campaign Summary */}
            {summary && (
              <div className="mt-8 pt-6 border-t border-gray-200">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">
                  Campaign Summary
                </h3>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Niche</span>
                    <span className="text-sm font-medium text-gray-900">
                      {summary.niche}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Location</span>
                    <span className="text-sm font-medium text-gray-900">
                      {summary.location}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Leads found</span>
                    <span className="text-sm font-medium text-gray-900">
                      {leads.length} / {summary.numberOfLeads}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-500">Status</span>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      {summary.status}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Leads Table */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200">
              <div className="px-6 py-4 border-b border-gray-200 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">
                    Discovered Leads
                  </h2>
                  {qualifiedCount > 0 && (
                    <p className="text-xs text-gray-400 mt-1">
                      {qualifiedCount} qualified &middot; {contactFoundCount} contacts found &middot; {briefCount} briefs ready
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={handleResearchAll}
                    disabled={qualifiedCount === 0 || isResearching || isDiscoveringContacts}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed transition-colors"
                  >
                    {isResearching ? (
                      <>
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                        </svg>
                        Generating briefs...
                      </>
                    ) : (
                      <>
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Generate Briefs
                      </>
                    )}
                  </button>
                  <button
                    onClick={handleDiscoverContacts}
                    disabled={leads.length === 0 || isDiscoveringContacts || isResearching || qualifiedCount === 0}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:bg-emerald-300 disabled:cursor-not-allowed transition-colors"
                  >
                    {isDiscoveringContacts ? (
                      <>
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                        </svg>
                        Discovering contacts...
                      </>
                    ) : (
                      <>
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                        </svg>
                        Discover Contacts
                      </>
                    )}
                  </button>
                </div>
              </div>
              {leads.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Business
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider hidden sm:table-cell">
                          Address
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Rating
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Qualification
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Contact
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Research
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Website
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Links
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {leads.map((lead) => (
                        <tr
                          key={lead.leadId ?? lead.placeId}
                          className="hover:bg-gray-50 transition-colors"
                        >
                          <td className="px-6 py-4">
                            <div className="text-sm font-medium text-gray-900">
                              {lead.businessName}
                            </div>
                            {lead.businessStatus &&
                              lead.businessStatus !== "OPERATIONAL" && (
                                <div className="text-xs text-amber-600 mt-1">
                                  {lead.businessStatus}
                                </div>
                              )}
                            {lead.qualification.qualificationStatus === "complete" && (
                              <div
                                className={`mt-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                                  lead.qualification.qualified
                                    ? "bg-emerald-100 text-emerald-800"
                                    : "bg-gray-100 text-gray-700"
                                }`}
                              >
                                {lead.qualification.qualified
                                  ? "Qualified prospect"
                                  : "Not qualified"}
                              </div>
                            )}
                            {lead.existing && (
                              <div className="mt-2 space-y-1.5">
                                <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800">
                                  Existing lead found
                                </span>
                                {lead.duplicateInfo && (
                                  <div className="text-[10px] text-gray-500">
                                    {lead.duplicateInfo.websiteVersions > 0
                                      ? `Website v${lead.duplicateInfo.latestWebsiteVersion} · ${formatDate(lead.duplicateInfo.lastGeneratedAt)}`
                                      : "No website yet"}{" "}
                                    · first seen {formatDate(lead.duplicateInfo.firstSeenAt)}
                                  </div>
                                )}
                                <div className="flex flex-wrap gap-2">
                                  <button
                                    onClick={() =>
                                      router.push(`/history?lead=${lead.leadId}`)
                                    }
                                    className="text-[10px] font-medium text-blue-600 hover:text-blue-800"
                                  >
                                    View existing
                                  </button>
                                  <button
                                    onClick={() => handleUpdateLead(lead)}
                                    disabled={isUpdatingLeadId === lead.leadId}
                                    className="text-[10px] font-medium text-indigo-600 hover:text-indigo-800 disabled:text-gray-300 disabled:cursor-not-allowed"
                                  >
                                    {isUpdatingLeadId === lead.leadId
                                      ? "Updating..."
                                      : "Update"}
                                  </button>
                                  <button
                                    onClick={() => handleGenerateWebsite(lead)}
                                    className="text-[10px] font-medium text-purple-700 hover:text-purple-900"
                                  >
                                    Regenerate
                                  </button>
                                </div>
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-4 hidden sm:table-cell">
                            <div className="text-sm text-gray-500 max-w-xs truncate">
                              {lead.address}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            {lead.rating !== undefined ? (
                              <div className="flex items-center gap-1">
                                <span className="text-sm font-medium text-gray-900">
                                  {lead.rating.toFixed(1)}
                                </span>
                                {lead.reviewCount !== undefined && (
                                  <span className="text-xs text-gray-400">
                                    ({lead.reviewCount})
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-sm text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-6 py-4 min-w-64">
                            {lead.qualification.qualificationStatus === "complete" ? (
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <div className="text-sm font-semibold text-gray-900">
                                    {lead.qualification.opportunityScore}/100
                                  </div>
                                  {lead.qualification.websiteOpportunity && (
                                    <span
                                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                        lead.qualification.websiteOpportunity === "NO_WEBSITE"
                                          ? "bg-emerald-100 text-emerald-800"
                                          : lead.qualification.websiteOpportunity === "NEEDS_REDESIGN"
                                            ? "bg-amber-100 text-amber-800"
                                            : "bg-gray-100 text-gray-600"
                                      }`}
                                    >
                                      {({
                                        NO_WEBSITE: "No website",
                                        NEEDS_REDESIGN: "Needs redesign",
                                        GOOD_WEBSITE: "Good website",
                                        UNKNOWN: "Unknown",
                                      })[lead.qualification.websiteOpportunity]}
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-gray-600">
                                  {lead.qualification.reason}
                                </p>
                                <p className="text-xs text-gray-400">
                                  {lead.qualification.websiteAssessment}
                                </p>
                              </div>
                            ) : (
                              <p className="text-xs text-amber-700">
                                {lead.qualification.reason}
                              </p>
                            )}
                          </td>
                          <td className="px-6 py-4 min-w-48">
                            {lead.contactDiscovery
                              ? lead.contactDiscovery.emailStatus === "found" && lead.contactDiscovery.email
                                ? (
                                    <div className="space-y-1">
                                      <div className="text-sm font-medium text-gray-900 break-all">
                                        <a href={`mailto:${lead.contactDiscovery.email}`} className="text-blue-600 hover:text-blue-800">
                                          {lead.contactDiscovery.email}
                                        </a>
                                      </div>
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                          lead.contactDiscovery.emailType === "business"
                                            ? "bg-blue-100 text-blue-800"
                                            : lead.contactDiscovery.emailType === "professional"
                                              ? "bg-purple-100 text-purple-800"
                                              : "bg-gray-100 text-gray-700"
                                        }`}>
                                          {lead.contactDiscovery.emailType ?? "unknown"}
                                        </span>
                                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                          lead.contactDiscovery.emailConfidence === "high"
                                            ? "bg-emerald-100 text-emerald-800"
                                            : lead.contactDiscovery.emailConfidence === "medium"
                                              ? "bg-amber-100 text-amber-800"
                                              : "bg-gray-100 text-gray-600"
                                        }`}>
                                          {lead.contactDiscovery.emailConfidence} confidence
                                        </span>
                                      </div>
                                      {lead.contactDiscovery.emailSourceUrl && (
                                        <a
                                          href={lead.contactDiscovery.emailSourceUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-[10px] text-gray-400 hover:text-gray-600 break-all"
                                        >
                                          Source
                                        </a>
                                      )}
                                    </div>
                                  )
                                : lead.contactDiscovery.emailStatus === "needs_review"
                                  ? (
                                      <div className="space-y-1">
                                        {lead.contactDiscovery.email && (
                                          <div className="text-sm text-gray-500 break-all">
                                            {lead.contactDiscovery.email}
                                          </div>
                                        )}
                                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800">
                                          Needs review
                                        </span>
                                      </div>
                                    )
                                  : (
                                      <div className="space-y-1">
                                        {lead.contactDiscovery.phone ? (
                                          <a
                                            href={`tel:${lead.contactDiscovery.phone}`}
                                            className="text-sm text-blue-600 hover:text-blue-800"
                                          >
                                            {lead.contactDiscovery.phone}
                                          </a>
                                        ) : (
                                          <span className="text-xs text-gray-400">
                                            {lead.contactDiscovery.discoveryPath === "no_website"
                                              ? "No website or public email"
                                              : "Not found"}
                                          </span>
                                        )}
                                        {lead.contactDiscovery.phone && lead.contactDiscovery.emailStatus === "not_found" && (
                                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold bg-sky-100 text-sky-800">
                                            Phone only
                                          </span>
                                        )}
                                      </div>
                                    )
                              : lead.qualification?.qualified
                                ? (
                                    <span className="text-xs text-gray-400">
                                      Pending
                                    </span>
                                  )
                                : (
                                    <span className="text-xs text-gray-300">
                                      &mdash;
                                    </span>
                                  )}
                          </td>
                          <td className="px-6 py-4 min-w-44">
                            {!lead.qualification?.qualified ? (
                              <span className="text-xs text-gray-300">
                                &mdash;
                              </span>
                            ) : lead.research?.status === "in_progress" ? (
                              <div className="flex items-center gap-2 text-xs text-gray-500">
                                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                                </svg>
                                Researching...
                              </div>
                            ) : lead.research?.status === "complete" &&
                              lead.research.websiteResearch ? (
                              <div className="space-y-1">
                                <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-indigo-100 text-indigo-800">
                                  Brief ready
                                </span>
                                <button
                                  onClick={() =>
                                    setViewer({
                                      businessName: lead.businessName,
                                      research: lead.research!.websiteResearch!,
                                    })
                                  }
                                  className="block text-xs font-medium text-indigo-600 hover:text-indigo-800"
                                >
                                  View brief
                                </button>
                              </div>
                            ) : lead.research?.status === "failed" ? (
                              <div className="space-y-1">
                                <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-red-100 text-red-700">
                                  Failed
                                </span>
                                {lead.research.errorMessage && (
                                  <p className="text-[10px] text-red-600">
                                    {lead.research.errorMessage}
                                  </p>
                                )}
                                <button
                                  onClick={() => handleResearchOne(lead)}
                                  disabled={isResearching}
                                  className="block text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:text-gray-300 disabled:cursor-not-allowed"
                                >
                                  Retry
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => handleResearchOne(lead)}
                                disabled={isResearching}
                                className="text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:text-gray-300 disabled:cursor-not-allowed"
                              >
                                Generate Brief
                              </button>
                            )}
                          </td>
                          <td className="px-6 py-4 min-w-48">
                            {!lead.qualification?.qualified ||
                            !lead.research?.websiteResearch ? (
                              <span className="text-xs text-gray-300">
                                &mdash;
                              </span>
                            ) : lead.website?.status === "in_progress" ? (
                              <div className="flex items-center gap-2 text-xs text-gray-500">
                                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                                </svg>
                                Generating...
                              </div>
                            ) : lead.website?.status === "completed" &&
                              lead.website.projectId ? (
                              <div className="space-y-1">
                                <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-purple-100 text-purple-800">
                                  Website ready
                                </span>
                                <a
                                  href={`/preview/${lead.website.projectId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="block text-xs font-medium text-purple-700 hover:text-purple-900"
                                >
                                  View preview
                                </a>
                              </div>
                            ) : lead.website?.status === "failed" ? (
                              <div className="space-y-1">
                                <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-red-100 text-red-700">
                                  Failed
                                </span>
                                {lead.website.errorMessage && (
                                  <p className="text-[10px] text-red-600">
                                    {lead.website.errorMessage}
                                  </p>
                                )}
                                <button
                                  onClick={() => handleGenerateWebsite(lead)}
                                  className="block text-xs font-medium text-purple-700 hover:text-purple-900"
                                >
                                  Retry
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => handleGenerateWebsite(lead)}
                                className="text-xs font-medium text-purple-700 hover:text-purple-900"
                              >
                                Generate Website
                              </button>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex gap-3">
                              <a
                                href={lead.googleMapsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm text-blue-600 hover:text-blue-800"
                              >
                                Maps
                              </a>
                              {lead.websiteUrl && (
                                <a
                                  href={lead.websiteUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sm text-blue-600 hover:text-blue-800"
                                >
                                  Website
                                </a>
                              )}
                              {(lead.website?.status === "completed" ||
                                (lead.duplicateInfo?.websiteVersions ?? 0) > 0) && (
                                <button
                                  onClick={() =>
                                    router.push(`/history?lead=${lead.leadId}`)
                                  }
                                  className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
                                >
                                  Deploy
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-16 text-gray-500">
                  <p>
                    {summary
                      ? "No leads found for this search."
                      : "Submit the form to discover potential clients."}
                  </p>
                  {summary && (
                    <p className="mt-2 text-xs text-gray-400">
                      Try broadening your niche or location.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Agent Jobs */}
            <div className="mt-8 bg-white rounded-lg shadow-sm border border-gray-200">
              <div className="px-6 py-4 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">
                    Agent Jobs
                  </h2>
                  <p className="text-xs text-gray-400 mt-1">
                    Start, pause, resume, and stop agent workflows.
                  </p>
                </div>
                <button
                  onClick={fetchJobs}
                  disabled={jobsLoading}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-50 rounded-md hover:bg-gray-100 border border-gray-200 disabled:opacity-50 transition-colors"
                >
                  {jobsLoading ? "Refreshing..." : "Refresh"}
                </button>
              </div>
              {jobs.length > 0 ? (
                <ul className="divide-y divide-gray-50">
                  {jobs.slice(0, 8).map((job) => (
                    <li
                      key={job.id}
                      className="px-6 py-3 flex flex-wrap items-center gap-x-4 gap-y-2"
                    >
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                          JOB_STATUS_STYLES[job.status] ?? "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {job.status}
                      </span>
                      <span className="text-sm font-medium text-gray-900">
                        {job.type.replace(/_/g, " ")}
                      </span>
                      {job.currentStep && (
                        <span className="text-xs text-gray-500">
                          {job.currentStep}
                        </span>
                      )}
                      <span className="text-xs text-gray-400">
                        {job.progress}%
                      </span>
                      <span className="text-xs text-gray-400">
                        {formatDate(job.createdAt)}
                      </span>
                      {job.error && (
                        <span className="text-xs text-red-600">{job.error}</span>
                      )}
                      <div className="ml-auto flex items-center gap-2">
                        {job.status === "running" && (
                          <>
                            <button
                              onClick={() => handleJobControl(job, "pause")}
                              className="text-xs font-medium text-amber-700 hover:text-amber-900"
                            >
                              Pause
                            </button>
                            <button
                              onClick={() => handleJobControl(job, "stop")}
                              className="text-xs font-medium text-red-600 hover:text-red-800"
                            >
                              Stop
                            </button>
                          </>
                        )}
                        {job.status === "paused" && (
                          <>
                            <button
                              onClick={() => handleJobControl(job, "resume")}
                              className="text-xs font-medium text-emerald-700 hover:text-emerald-900"
                            >
                              Resume
                            </button>
                            <button
                              onClick={() => handleJobControl(job, "stop")}
                              className="text-xs font-medium text-red-600 hover:text-red-800"
                            >
                              Stop
                            </button>
                          </>
                        )}
                        {(job.status === "stopped" || job.status === "failed") && (
                          <button
                            onClick={() => handleJobControl(job, "retry")}
                            className="text-xs font-medium text-blue-700 hover:text-blue-900"
                          >
                            Retry
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-6 py-10 text-center text-sm text-gray-400">
                  No agent jobs yet. Run a campaign or start a brief to see work here.
                </p>
              )}
            </div>
          </div>
        </div>
      </main>

      {viewer && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto"
          role="dialog"
          aria-modal="true"
        >
          <div
            className="fixed inset-0 bg-black/40"
            onClick={() => setViewer(null)}
          />
          <div className="relative min-h-full flex items-start justify-center p-4 sm:p-8">
            <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6 sm:p-8">
              <div className="flex items-start justify-between gap-4 mb-6">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    Website Specification
                  </h3>
                  <p className="text-sm text-gray-500 mt-1">
                    {viewer.businessName}
                  </p>
                </div>
                <button
                  onClick={() => setViewer(null)}
                  className="text-gray-400 hover:text-gray-600"
                  aria-label="Close"
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="space-y-6">
                <SpecSection
                  title="Business Summary"
                  body={viewer.research.businessSummary}
                />
                <SpecSection title="Services" items={viewer.research.services} />
                <SpecSection
                  title="Target Audience"
                  body={viewer.research.targetAudience}
                />
                <SpecSection title="Location" body={viewer.research.location} />
                <SpecSection
                  title="Brand Observations"
                  items={viewer.research.brandObservations}
                />
                <SpecSection
                  title="Existing Website Assessment"
                  body={viewer.research.existingWebsiteAssessment}
                />
                <SpecSection
                  title="Suggested Pages"
                  items={viewer.research.suggestedPages}
                />
                <SpecSection
                  title="Suggested Sections"
                  items={viewer.research.suggestedSections}
                />
                <SpecSection title="Primary CTA" body={viewer.research.primaryCTA} />
                <SpecSection
                  title="Copy Direction"
                  body={viewer.research.copyDirection}
                />
                <SpecSection
                  title="Visual Direction"
                  body={viewer.research.visualDirection}
                />
                <SpecSection
                  title="Verified Facts"
                  items={viewer.research.verifiedFacts}
                />
                <SpecSection title="Unknowns" items={viewer.research.unknowns} />
                <SpecSection title="Sources" links={viewer.research.sources} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}