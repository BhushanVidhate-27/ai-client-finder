"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Types (kept local to avoid coupling to server-only agent types)
// ---------------------------------------------------------------------------

interface AgentDef {
  id: string;
  name: string;
  description: string;
  jobType: string;
  permissions: string[];
  status: "available" | "planned";
}

interface AgentJob {
  id: string;
  type: string;
  status: string;
  progress: number;
  currentStep: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  error: string | null;
}

interface ActivityEntry {
  id: string;
  action: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface AgentDetail {
  agent: AgentDef;
  jobs: AgentJob[];
  activity: ActivityEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function statusBadge(status: string): string {
  switch (status) {
    case "available":
      return "bg-emerald-100 text-emerald-800";
    case "planned":
      return "bg-amber-100 text-amber-800";
    case "running":
      return "bg-blue-100 text-blue-700";
    case "completed":
      return "bg-emerald-100 text-emerald-700";
    case "failed":
    case "stopped":
      return "bg-red-100 text-red-700";
    case "paused":
      return "bg-amber-100 text-amber-700";
    default:
      return "bg-gray-100 text-gray-700";
  }
}

function milestoneIcon(action: string): string {
  if (action.includes("succeeded") || action.includes("completed"))
    return "\u2713";
  if (
    action.includes("failed") ||
    action.includes("rejected") ||
    action.includes("error")
  )
    return "\u2717";
  if (action.includes("stopped")) return "\u2717";
  return "\u2192";
}

function milestoneColor(action: string): string {
  if (action.includes("succeeded") || action.includes("completed"))
    return "text-emerald-700";
  if (
    action.includes("failed") ||
    action.includes("rejected") ||
    action.includes("error")
  )
    return "text-red-700";
  if (action.includes("stopped")) return "text-red-700";
  return "text-gray-600";
}

function actionLabel(action: string): string {
  return action
    .replace(/^agent\./, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function agentMeta(job: AgentJob): Record<string, unknown> | null {
  const raw = job.metadata?.agent;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgentsClient() {
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/agents");
      if (!res.ok) throw new Error("Failed to load agents.");
      const data = (await res.json()) as { agents: AgentDef[] };
      setAgents(data.agents ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string, jobId?: string) => {
    try {
      const qs = jobId ? `?jobId=${encodeURIComponent(jobId)}` : "";
      const res = await fetch(`/api/admin/agents/${id}${qs}`);
      if (!res.ok) throw new Error("Failed to load agent detail.");
      const data = (await res.json()) as AgentDetail;
      setDetail(data);
      setActivity(data.activity ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load detail.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch, state updates only after external response
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    if (selectedId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch, state updates only after external response
      void loadDetail(selectedId);
    }
  }, [selectedId, loadDetail]);

  const handleRun = async (agentId: string) => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/agents/${agentId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: goal || undefined }),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok && typeof data.error === "string") {
        throw new Error(data.error);
      }
      // Refresh detail to show the new job.
      if (selectedId) await loadDetail(selectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed.");
    } finally {
      setRunning(false);
    }
  };

  const selected = detail?.agent ?? agents.find((a) => a.id === selectedId) ?? null;
  const latestJob = detail?.jobs?.[0] ?? null;
  const meta = latestJob ? agentMeta(latestJob) : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
          <h1 className="text-lg font-semibold text-gray-900">
            Agent Orchestration
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
                void loadAgents();
                if (selectedId) void loadDetail(selectedId);
              }}
              className="rounded-md border border-gray-300 px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[280px_1fr]">
        {/* Agent list */}
        <aside className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Agents ({agents.length})
          </h2>
          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : agents.length === 0 ? (
            <p className="text-sm text-gray-500">No agents registered.</p>
          ) : (
            <ul className="space-y-2">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <button
                    onClick={() => {
                      setSelectedId(agent.id);
                      setDetail(null);
                    }}
                    className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                      selectedId !== agent.id
                        ? "border-transparent hover:bg-gray-50"
                        : "border-blue-200 bg-blue-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-gray-900">
                        {agent.name}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusBadge(agent.status)}`}
                      >
                        {agent.status}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500 line-clamp-2">
                      {agent.description}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Detail pane */}
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          {error && (
            <p className="mb-3 text-sm text-red-600">{error}</p>
          )}

          {!selected ? (
            <div className="py-12 text-center text-gray-500">
              Select an agent to view its detail and jobs.
            </div>
          ) : (
            <div className="space-y-6">
              {/* Agent header */}
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-lg font-semibold text-gray-900">
                    {selected.name}
                  </h2>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadge(selected.status)}`}
                  >
                    {selected.status}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-500">
                  {selected.description}
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-400">
                  <span>Type: {selected.jobType}</span>
                  <span>
                    Permissions:{" "}
                    {selected.permissions.length > 0
                      ? selected.permissions.join(", ")
                      : "none"}
                  </span>
                </div>
              </div>

              {/* Run form (only for available agents) */}
              {selected.status === "available" && (
                <div className="rounded-md border border-gray-200 p-3">
                  <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
                    Run Agent
                  </h3>
                  <div className="flex items-end gap-3">
                    <label className="flex-1 text-sm">
                      <span className="mb-1 block text-gray-600">
                        Goal (optional)
                      </span>
                      <input
                        type="text"
                        value={goal}
                        onChange={(e) => setGoal(e.target.value)}
                        placeholder={selected.description}
                        className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                      />
                    </label>
                    <button
                      onClick={() => {
                        void handleRun(selected.id);
                      }}
                      disabled={running}
                      className="shrink-0 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300"
                    >
                      {running ? "Running…" : "Run"}
                    </button>
                  </div>
                </div>
              )}

              {/* Latest job / status */}
              {latestJob && (
                <div className="rounded-md border border-gray-200 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
                      Latest Job
                    </h3>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadge(latestJob.status)}`}
                    >
                      {latestJob.status}
                    </span>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                    <div>
                      <dt className="text-gray-400">Iteration</dt>
                      <dd className="font-medium text-gray-900">
                        {meta
                          ? `${meta.iteration ?? "—"} / ${meta.maxIterations ?? "—"}`
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-gray-400">Current Step</dt>
                      <dd className="font-medium text-gray-900">
                        {latestJob.currentStep ?? "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-gray-400">Progress</dt>
                      <dd className="font-medium text-gray-900">
                        {latestJob.progress}%
                      </dd>
                    </div>
                    <div>
                      <dt className="text-gray-400">Created</dt>
                      <dd className="font-medium text-gray-900">
                        {formatDate(latestJob.createdAt)}
                      </dd>
                    </div>
                  </dl>

                  {latestJob.error && (
                    <p className="mt-2 text-xs text-red-600">
                      {latestJob.error}
                    </p>
                  )}
                </div>
              )}

              {/* Recent activity (milestones) */}
              {activity.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
                    Recent Activity ({activity.length})
                  </h3>
                  <ul className="space-y-1 text-sm">
                    {activity.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex items-baseline gap-3"
                      >
                        <span className="w-36 shrink-0 text-xs text-gray-400">
                          {formatDate(entry.createdAt)}
                        </span>
                        <span
                          className={`font-medium ${milestoneColor(entry.action)}`}
                        >
                          {milestoneIcon(entry.action)}{" "}
                          {actionLabel(entry.action)}
                        </span>
                        {entry.metadata &&
                          typeof entry.metadata === "object" &&
                          "step" in
                            (entry.metadata as Record<string, unknown>) && (
                            <span className="text-xs text-gray-500">
                              {
                                (entry.metadata as Record<string, unknown>)
                                  .step as string
                              }
                            </span>
                          )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Jobs list */}
              {detail && detail.jobs.length > 1 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
                    All Jobs ({detail.jobs.length})
                  </h3>
                  <ul className="divide-y divide-gray-100 text-sm">
                    {detail.jobs.slice(0, 10).map((job) => {
                      const jm = agentMeta(job);
                      return (
                        <li
                          key={job.id}
                          className="flex items-center justify-between py-2"
                        >
                          <div>
                            <span className="font-medium text-gray-800">
                              {job.type}
                            </span>
                            <span className="ml-2 text-xs text-gray-400">
                              {formatDate(job.createdAt)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            {jm && (
                              <span className="text-xs text-gray-500">
                                {String(jm.iteration ?? "—")}/
                                {String(jm.maxIterations ?? "—")}
                              </span>
                            )}
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(job.status)}`}
                            >
                              {job.status}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}