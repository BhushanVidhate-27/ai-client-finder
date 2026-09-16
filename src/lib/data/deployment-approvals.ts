/**
 * Deployment approval persistence (Agent 9 / Step 15).
 *
 * A human deployment approval is bound to the exact immutable website version
 * (website_versions.id) and the artifact hash recorded for that version.
 * Approvals never transfer between prospects, versions or hashes, and at most
 * one valid approval per version is enforced by a partial unique index. The
 * campaign orchestrator only honours an approval when it matches the current
 * verified version and its exact artifact hash.
 */

import { randomUUID } from "node:crypto";
import { getDb, withTransaction } from "@/lib/data/db";

export type DeploymentApprovalStatus = "valid" | "revoked";

export interface DeploymentApprovalRow {
  id: string;
  leadId: string;
  websiteVersionId: string;
  artifactHash: string;
  status: DeploymentApprovalStatus;
  createdBy: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentApprovalCreateInput {
  leadId: string;
  websiteVersionId: string;
  artifactHash: string;
  createdBy: string | null;
  expiresAt?: string | null;
}

type StoredRow = Record<string, unknown>;

function parseRow(row: StoredRow): DeploymentApprovalRow {
  return {
    id: String(row.id),
    leadId: String(row.lead_id),
    websiteVersionId: String(row.website_version_id),
    artifactHash: String(row.artifact_hash),
    status: String(row.status) as DeploymentApprovalStatus,
    createdBy: row.created_by ? String(row.created_by) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Creates a human approval bound to the exact version + artifact hash and
 * revokes any previously-valid approval for the same version (at most one valid
 * approval per version is enforced by the partial unique index). Approval never
 * carries over to a different hash/version — the operator re-approves the exact
 * artifact.
 */
export function createDeploymentApproval(
  input: DeploymentApprovalCreateInput,
): DeploymentApprovalRow {
  return withTransaction(() => {
    const db = getDb();
    const now = new Date().toISOString();

    const existing = db
      .prepare(
        "SELECT id FROM deployment_approvals WHERE website_version_id = ? AND status = 'valid'",
      )
      .get(input.websiteVersionId) as { id: string } | undefined;
    if (existing) {
      db.prepare(
        "UPDATE deployment_approvals SET status = 'revoked', updated_at = ? WHERE id = ?",
      ).run(now, existing.id);
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO deployment_approvals (
         id, lead_id, website_version_id, artifact_hash, status,
         created_by, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'valid', ?, ?, ?, ?)`,
    ).run(
      id,
      input.leadId,
      input.websiteVersionId,
      input.artifactHash,
      input.createdBy ?? null,
      input.expiresAt ?? null,
      now,
      now,
    );
    return parseRow(
      db.prepare("SELECT * FROM deployment_approvals WHERE id = ?").get(id)!,
    );
  });
}

export function getValidDeploymentApproval(
  websiteVersionId: string,
): DeploymentApprovalRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM deployment_approvals
       WHERE website_version_id = ? AND status = 'valid'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(websiteVersionId);
  return row ? parseRow(row) : null;
}

export function listDeploymentApprovalsByLead(
  leadId: string,
): DeploymentApprovalRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM deployment_approvals WHERE lead_id = ? ORDER BY created_at DESC",
    )
    .all(leadId) as StoredRow[];
  return rows.map(parseRow);
}

export function revokeDeploymentApproval(websiteVersionId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE deployment_approvals SET status = 'revoked', updated_at = ?
       WHERE website_version_id = ? AND status = 'valid'`,
    )
    .run(new Date().toISOString(), websiteVersionId);
  return Number(result.changes) > 0;
}