import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/data/db";

export interface ActivityRow {
  id: string;
  action: string;
  campaignId: string | null;
  leadId: string | null;
  jobId: string | null;
  websiteVersionId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface LogActivityInput {
  action: string;
  campaignId?: string | null;
  leadId?: string | null;
  jobId?: string | null;
  websiteVersionId?: string | null;
  metadata?: Record<string, unknown> | null;
}

type StoredRow = Record<string, unknown>;

function parseStored(row: StoredRow): ActivityRow {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: String(row.id),
    action: String(row.action),
    campaignId: row.campaign_id ? String(row.campaign_id) : null,
    leadId: row.lead_id ? String(row.lead_id) : null,
    jobId: row.job_id ? String(row.job_id) : null,
    websiteVersionId: row.website_version_id
      ? String(row.website_version_id)
      : null,
    metadata,
    createdAt: String(row.created_at),
  };
}

export function logActivity(input: LogActivityInput): void {
  getDb()
    .prepare(
      `INSERT INTO activity_log (
         id, action, campaign_id, lead_id, job_id, website_version_id, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.action,
      input.campaignId ?? null,
      input.leadId ?? null,
      input.jobId ?? null,
      input.websiteVersionId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      new Date().toISOString(),
    );
}

export function listActivity(input?: {
  campaignId?: string | null;
  leadId?: string | null;
  jobId?: string | null;
  campaignIds?: string[];
  limit?: number;
}): ActivityRow[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (input?.campaignId) {
    clauses.push("campaign_id = ?");
    params.push(input.campaignId);
  }
  if (input?.leadId) {
    clauses.push("lead_id = ?");
    params.push(input.leadId);
  }
  if (input?.jobId) {
    clauses.push("job_id = ?");
    params.push(input.jobId);
  }
  if (input?.campaignIds && input.campaignIds.length > 0) {
    clauses.push(
      `campaign_id IN (${input.campaignIds.map(() => "?").join(", ")})`,
    );
    params.push(...input.campaignIds);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" OR ")}` : "";
  const limit = input?.limit ?? 100;
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT * FROM activity_log ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params) as StoredRow[];
  return rows.map(parseStored);
}