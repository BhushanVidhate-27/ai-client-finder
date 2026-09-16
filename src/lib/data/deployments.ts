import { randomUUID } from "node:crypto";
import { getDb, withTransaction } from "@/lib/data/db";
import type { DeploymentProviderId, DeploymentStatus } from "@/lib/deployment/types";

// ---------------------------------------------------------------------------
// Deployment record persistence (Step 13)
// ---------------------------------------------------------------------------

export const DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  "pending",
  "validating",
  "uploading",
  "building",
  "deploying",
  "ready",
  "failed",
  "cancelled",
];

export const ACTIVE_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  "pending",
  "validating",
  "uploading",
  "building",
  "deploying",
];

export function isActiveDeploymentStatus(status: string): status is DeploymentStatus {
  return (ACTIVE_DEPLOYMENT_STATUSES as readonly string[]).includes(status);
}

export interface DeploymentRecord {
  id: string;
  websiteProjectId: string;
  leadId: string;
  websiteVersionId: string;
  version: number;
  provider: DeploymentProviderId;
  status: DeploymentStatus;
  providerDeploymentId: string | null;
  deploymentUrl: string | null;
  jobId: string | null;
  artifactHash: string | null;
  failureReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentRecordPatch {
  status?: DeploymentStatus;
  providerDeploymentId?: string | null;
  deploymentUrl?: string | null;
  jobId?: string | null;
  artifactHash?: string | null;
  failureReason?: string | null;
  metadata?: Record<string, unknown>;
}

// ------------------------------ transitions --------------------------------

const LEGAL_DEPLOYMENT_TRANSITIONS: Record<string, readonly DeploymentStatus[]> = {
  pending: ["validating", "uploading", "failed", "cancelled"],
  validating: ["uploading", "failed", "cancelled"],
  uploading: ["building", "failed", "cancelled"],
  building: ["deploying", "failed", "cancelled"],
  deploying: ["ready", "failed", "cancelled"],
  ready: [],
  failed: [],
  cancelled: [],
};

export function isLegalDeploymentTransition(
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  return (LEGAL_DEPLOYMENT_TRANSITIONS[from] ?? []).includes(to as DeploymentStatus);
}

export class DeploymentTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Illegal deployment transition "${from}" -> "${to}".`);
    this.name = "DeploymentTransitionError";
  }
}

// ------------------------------ parsing ------------------------------------

type StoredRow = Record<string, unknown>;

function parseMetadata(json: unknown): Record<string, unknown> {
  if (typeof json !== "string" || !json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseRow(row: StoredRow): DeploymentRecord {
  return {
    id: String(row.id),
    websiteProjectId: String(row.website_project_id),
    leadId: String(row.lead_id),
    websiteVersionId: String(row.website_version_id),
    version: Number(row.version),
    provider: String(row.provider) as DeploymentProviderId,
    status: String(row.status) as DeploymentStatus,
    providerDeploymentId: row.provider_deployment_id
      ? String(row.provider_deployment_id)
      : null,
    deploymentUrl: row.deployment_url ? String(row.deployment_url) : null,
    jobId: row.job_id ? String(row.job_id) : null,
    artifactHash: row.artifact_hash ? String(row.artifact_hash) : null,
    failureReason: row.failure_reason ? String(row.failure_reason) : null,
    metadata: parseMetadata(row.metadata_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  return /UNIQUE|SQLITE_CONSTRAINT/i.test(code);
}

// ------------------------------ queries ------------------------------------

export function getDeploymentRecord(id: string): DeploymentRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM deployments WHERE id = ?")
    .get(id);
  return row ? parseRow(row) : null;
}

export function listDeploymentRecordsByLead(
  leadId: string,
  limit = 100,
): DeploymentRecord[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM deployments WHERE lead_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(leadId, limit) as StoredRow[];
  return rows.map(parseRow);
}

export function listDeploymentRecordsByProject(
  websiteProjectId: string,
): DeploymentRecord[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM deployments WHERE website_project_id = ? ORDER BY created_at DESC",
    )
    .all(websiteProjectId) as StoredRow[];
  return rows.map(parseRow);
}

export function getActiveDeploymentForProject(
  websiteProjectId: string,
): DeploymentRecord | null {
  const statuses = ACTIVE_DEPLOYMENT_STATUSES.map(() => "?").join(", ");
  const row = getDb()
    .prepare(
      `SELECT * FROM deployments
       WHERE website_project_id = ? AND status IN (${statuses})
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(websiteProjectId, ...ACTIVE_DEPLOYMENT_STATUSES);
  return row ? parseRow(row) : null;
}

// ------------------------------ writes -------------------------------------

/**
 * Creates a pending deployment record. Runs in a transaction so the existence
 * check and the insert are atomic; the one-active-per-project partial unique
 * index is the backstop that makes racing starts deterministic.
 */
export function createDeploymentRecord(input: {
  websiteProjectId: string;
  leadId: string;
  websiteVersionId: string;
  version: number;
  provider: DeploymentProviderId;
  artifactHash: string;
  jobId?: string;
  metadata?: Record<string, unknown>;
}): DeploymentRecord {
  return withTransaction(() => {
    const db = getDb();
    const existing = getActiveDeploymentForProject(input.websiteProjectId);
    if (existing) {
      throw new Error(
        `A deployment for this website project is already active (${existing.id}).`,
      );
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO deployments (
         id, website_project_id, lead_id, website_version_id, version, provider,
         status, provider_deployment_id, deployment_url, job_id, artifact_hash,
         failure_reason, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      id,
      input.websiteProjectId,
      input.leadId,
      input.websiteVersionId,
      input.version,
      input.provider,
      input.jobId ?? null,
      input.artifactHash,
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
    );

    return parseRow(db.prepare("SELECT * FROM deployments WHERE id = ?").get(id)!);
  });
}

/**
 * Applies a status/shape update to a deployment record with legal-transition
 * enforcement. Refuses to move a failed/cancelled/ready attempt backwards.
 */
export function updateDeploymentRecord(
  deploymentId: string,
  patch: DeploymentRecordPatch,
): DeploymentRecord {
  return withTransaction(() => {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM deployments WHERE id = ?")
      .get(deploymentId) as StoredRow | undefined;
    if (!row) {
      throw new Error(`Deployment "${deploymentId}" not found.`);
    }

    const from = String(row.status);
    const to = patch.status ? patch.status : from;
    if (patch.status && !isLegalDeploymentTransition(from, patch.status)) {
      throw new DeploymentTransitionError(from, patch.status);
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.providerDeploymentId !== undefined) {
      sets.push("provider_deployment_id = ?");
      values.push(patch.providerDeploymentId);
    }
    if (patch.deploymentUrl !== undefined) {
      sets.push("deployment_url = ?");
      values.push(patch.deploymentUrl);
    }
    if (patch.jobId !== undefined) {
      sets.push("job_id = ?");
      values.push(patch.jobId);
    }
    if (patch.artifactHash !== undefined) {
      sets.push("artifact_hash = ?");
      values.push(patch.artifactHash);
    }
    if (patch.failureReason !== undefined) {
      sets.push("failure_reason = ?");
      values.push(patch.failureReason);
    }
    if (to !== from) {
      sets.push("status = ?");
      values.push(to);
    }
    if (sets.length > 0) {
      const now = new Date().toISOString();
      values.push(now, deploymentId);
      db.prepare(
        `UPDATE deployments SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
      ).run(...values);
    }

    if (patch.metadata) {
      const current = db
        .prepare("SELECT metadata_json FROM deployments WHERE id = ?")
        .get(deploymentId) as StoredRow;
      const merged = { ...parseMetadata(current.metadata_json), ...patch.metadata };
      db.prepare("UPDATE deployments SET metadata_json = ? WHERE id = ?").run(
        JSON.stringify(merged),
        deploymentId,
      );
    }

    const finalRow = db
      .prepare("SELECT * FROM deployments WHERE id = ?")
      .get(deploymentId)!;
    return parseRow(finalRow);
  });
}

export function markDeploymentFailed(
  deploymentId: string,
  reason: string | null,
  metadata?: Record<string, unknown>,
): DeploymentRecord {
  return updateDeploymentRecord(deploymentId, {
    status: "failed",
    failureReason: reason,
    metadata,
  });
}

export function markDeploymentCancelled(
  deploymentId: string,
  metadata?: Record<string, unknown>,
): DeploymentRecord {
  return updateDeploymentRecord(deploymentId, {
    status: "cancelled",
    metadata,
  });
}

/** Returns true when an active deployment exists for the project. */
export function hasActiveDeploymentForProject(websiteProjectId: string): boolean {
  return getActiveDeploymentForProject(websiteProjectId) !== null;
}

/** Re-export used by tests to assert the DB-level guard is not bypassable. */
export function isUniqueViolationError(error: unknown): boolean {
  return isUniqueViolation(error);
}