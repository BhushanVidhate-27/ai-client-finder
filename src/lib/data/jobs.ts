import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/data/db";

export type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "interrupted"
  | "completed"
  | "failed";

export type JobType =
  | "campaign_discovery"
  | "contact_discovery"
  | "research"
  | "website_generation"
  | "deployment"
  | "outreach_safety"
  | "campaign_orchestration"
  | "lead_update";

export interface AgentJobRow {
  id: string;
  type: JobType | string;
  campaignId: string | null;
  leadId: string | null;
  status: JobStatus;
  progress: number;
  currentStep: string | null;
  startedAt: string | null;
  completedAt: string | null;
  stoppedAt: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface JobUpdate {
  status?: JobStatus;
  progress?: number;
  currentStep?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  stoppedAt?: string | null;
  error?: string | null;
}

type StoredRow = Record<string, unknown>;

function parseStored(row: StoredRow): AgentJobRow {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.metadata_json ?? "{}"));
    if (parsed && typeof parsed === "object") {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    metadata = {};
  }

  return {
    id: String(row.id),
    type: String(row.type),
    campaignId: row.campaign_id ? String(row.campaign_id) : null,
    leadId: row.lead_id ? String(row.lead_id) : null,
    status: String(row.status) as JobStatus,
    progress: Number(row.progress ?? 0),
    currentStep: row.current_step ? String(row.current_step) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    stoppedAt: row.stopped_at ? String(row.stopped_at) : null,
    error: row.error ? String(row.error) : null,
    metadata,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createJob(input: {
  type: JobType | string;
  campaignId?: string | null;
  leadId?: string | null;
  metadata?: Record<string, unknown>;
}): AgentJobRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO agent_jobs (
       id, type, campaign_id, lead_id, status, progress, current_step,
       metadata_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'queued', 0, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.type,
    input.campaignId ?? null,
    input.leadId ?? null,
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );
  return getJob(id)!;
}

export function getJob(id: string): AgentJobRow | null {
  const row = getDb().prepare("SELECT * FROM agent_jobs WHERE id = ?").get(id);
  return row ? parseStored(row) : null;
}

export function listJobs(limit = 50): AgentJobRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_jobs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as StoredRow[];
  return rows.map(parseStored);
}

export function listJobsByLead(leadId: string): AgentJobRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM agent_jobs WHERE lead_id = ? ORDER BY created_at DESC LIMIT 50",
    )
    .all(leadId) as StoredRow[];
  return rows.map(parseStored);
}

export function listJobsByCampaign(
  campaignId: string,
  limit = 50,
): AgentJobRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM agent_jobs WHERE campaign_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(campaignId, limit) as StoredRow[];
  return rows.map(parseStored);
}

/** Statuses that indicate a job is still being actively executed. */
export function isActiveJobStatus(status: string): boolean {
  return (
    status === "running" ||
    status === "stopping" ||
    status === "paused" ||
    status === "queued"
  );
}

export function updateJob(id: string, patch: JobUpdate): AgentJobRow | null {
  const allowedFields: Array<keyof JobUpdate> = [
    "status",
    "progress",
    "currentStep",
    "startedAt",
    "completedAt",
    "stoppedAt",
    "error",
  ];
  const sets = allowedFields
    .filter((field) => patch[field] !== undefined)
    .map((field) => `${fieldToColumn(field)} = ?`);
  if (sets.length === 0) return getJob(id);

  const params: unknown[] = allowedFields
    .filter((field) => patch[field] !== undefined)
    .map((field) => patch[field]!);
  params.push(new Date().toISOString(), id);

  getDb()
    .prepare(
      `UPDATE agent_jobs SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
    )
    .run(...params);
  return getJob(id);
}

/**
 * Merges a patch into the job's metadata_json column. Only the keys present in
 * `patch` are written; all other metadata is preserved. This is the only safe
 * way to write structured agent data without touching the fixed columns.
 */
export function updateJobMetadata(
  id: string,
  patch: Record<string, unknown>,
): AgentJobRow | null {
  const job = getJob(id);
  if (!job) return null;

  const merged = { ...job.metadata, ...patch };
  getDb()
    .prepare(
      `UPDATE agent_jobs SET metadata_json = ?, updated_at = ? WHERE id = ?`,
    )
    .run(JSON.stringify(merged), new Date().toISOString(), id);
  return getJob(id);
}

function fieldToColumn(field: keyof JobUpdate): string {
  switch (field) {
    case "currentStep":
      return "current_step";
    case "startedAt":
      return "started_at";
    case "completedAt":
      return "completed_at";
    case "stoppedAt":
      return "stopped_at";
    default:
      return field;
  }
}

/**
 * Atomically moves a job from one of the allowed source states to a target
 * state with a single UPDATE ... WHERE id AND status IN (...) statement.
 * Returns true when exactly one row was updated, false when the job was not
 * in a permitted state (e.g. already claimed by a concurrent retry).
 */
export function tryTransitionJobStatus(
  id: string,
  allowedFrom: readonly JobStatus[],
  to: JobStatus,
  patch?: Omit<JobUpdate, "status">,
): boolean {
  const sets = ["status = ?"];
  const values: unknown[] = [to];

  const columns: Array<keyof Omit<JobUpdate, "status">> = [
    "progress",
    "currentStep",
    "startedAt",
    "completedAt",
    "stoppedAt",
    "error",
  ];
  for (const field of columns) {
    if (patch?.[field] !== undefined) {
      sets.push(`${fieldToColumn(field)} = ?`);
      values.push(patch[field]);
    }
  }
  values.push(new Date().toISOString(), id);

  const placeholders = allowedFrom.map(() => "?").join(", ");
  const result = getDb()
    .prepare(
      `UPDATE agent_jobs
       SET ${sets.join(", ")}, updated_at = ?
       WHERE id = ? AND status IN (${placeholders})`,
    )
    .run(...values, ...allowedFrom);

  return Number(result.changes) === 1;
}

/**
 * Marks jobs left in running/stopping by a previous process as interrupted.
 * Ran at startup / before operating on the job store. Interrupted jobs keep
 * their history (progress, timestamps, metadata) and become eligible for an
 * explicit retry.
 */
export function interruptStaleJobs(): number {
  const db = getDb();
  const now = new Date().toISOString();

  const rows = db
    .prepare(
      `SELECT id, type FROM agent_jobs
       WHERE status IN ('running', 'stopping')
       ORDER BY created_at`,
    )
    .all() as Array<{ id: string; type: string }>;

  if (rows.length === 0) return 0;

  const placeholders = rows.map(() => "?").join(", ");
  db.prepare(
    `UPDATE agent_jobs SET
       status = 'interrupted',
       current_step = 'interrupted',
       stopped_at = ?,
       error = 'Server restarted; job interrupted.',
       updated_at = ?
     WHERE id IN (${placeholders})`,
  ).run(now, now, ...rows.map((row) => row.id));

  return rows.length;
}

let stateCheckedOnce = false;

/**
 * Idempotent per-process check that marks stale jobs as interrupted. Safe to
 * call on every request; performs a single cheap UPDATE when there is nothing
 * stale and is a no-op on subsequent calls within the same process.
 */
export function ensureJobStateFresh(): number {
  if (!stateCheckedOnce) {
    stateCheckedOnce = true;
    return interruptStaleJobs();
  }
  return 0;
}