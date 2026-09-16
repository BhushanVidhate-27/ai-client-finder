import { randomUUID } from "node:crypto";
import { getDb, withTransaction } from "@/lib/data/db";
import type { WebsiteProject } from "@/lib/website-project";

// ---------------------------------------------------------------------------
// Persisted entity shapes (Step 12)
// ---------------------------------------------------------------------------

export interface WebsiteProjectRecord {
  projectId: string;
  leadId: string;
  currentVersion: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export type WebsiteVersionStatus =
  | "draft"
  | "building"
  | "qa"
  | "ready"
  | "current"
  | "failed"
  | "stopped"
  | "completed";

export type VersionBuildStatus = "pending" | "building" | "success" | "failed";
export type VersionQaStatus = "pending" | "qa" | "pass" | "fail";

export interface WebsiteVersionRow {
  // Version row identity (a UUID). Kept as `projectId` for legacy
  // compatibility — this is the value that used to be the website project id
  // and is still used as the preview identifier for a version's artifact.
  projectId: string;
  websiteProjectId: string | null;
  leadId: string;
  version: number;
  status: string;
  // Legacy DB-embedded website project; null for workspace-backed versions.
  project: WebsiteProject | null;
  isCurrent: boolean;
  buildStatus: VersionBuildStatus | null;
  qaStatus: VersionQaStatus | null;
  workspaceId: string | null;
  artifactHash: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const VERSION_STATUSES: Readonly<Record<string, WebsiteVersionStatus>> = {
  draft: "draft",
  building: "building",
  qa: "qa",
  ready: "ready",
  current: "current",
  failed: "failed",
  stopped: "stopped",
  completed: "completed",
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

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

function parseStoredProject(json: unknown): WebsiteProject | null {
  if (typeof json !== "string" || !json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const project = parsed as WebsiteProject;
    return Array.isArray(project.pages) ? project : null;
  } catch {
    return null;
  }
}

function parseStored(row: StoredRow): WebsiteVersionRow {
  const rawProject = parseStoredProject(row.website_project_json);
  return {
    projectId: String(row.id),
    websiteProjectId: row.project_id ? String(row.project_id) : null,
    leadId: String(row.lead_id),
    version: Number(row.version),
    status: String(row.status),
    project: rawProject,
    isCurrent: Number(row.is_current) === 1,
    buildStatus: row.build_status ? (String(row.build_status) as VersionBuildStatus) : null,
    qaStatus: row.qa_status ? (String(row.qa_status) as VersionQaStatus) : null,
    workspaceId: row.workspace_id ? String(row.workspace_id) : null,
    artifactHash: row.artifact_hash ? String(row.artifact_hash) : null,
    metadata: parseMetadata(row.metadata_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseProjectRow(row: StoredRow): WebsiteProjectRecord {
  return {
    projectId: String(row.id),
    leadId: String(row.lead_id),
    currentVersion: Number(row.current_version ?? 0),
    status: String(row.status),
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

// ---------------------------------------------------------------------------
// Website projects
// ---------------------------------------------------------------------------

export function getWebsiteProjectRecord(
  projectId: string,
): WebsiteProjectRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM website_projects WHERE id = ?")
    .get(projectId);
  return row ? parseProjectRow(row) : null;
}

export function getWebsiteProjectRecordByLeadId(
  leadId: string,
): WebsiteProjectRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM website_projects WHERE lead_id = ?")
    .get(leadId);
  return row ? parseProjectRow(row) : null;
}

export function listWebsiteProjects(): WebsiteProjectRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM website_projects ORDER BY created_at ASC")
    .all() as StoredRow[];
  return rows.map(parseProjectRow);
}

/**
 * Ensures a website project exists for a lead and returns it. Projects are
 * keyed by the canonical lead identity (lead id), never by business name or any
 * other client-supplied label, and one lead maps to exactly one project. Uses
 * INSERT OR IGNORE so a concurrent ensure for the same lead cannot wedge.
 */
export function ensureWebsiteProject(leadId: string): WebsiteProjectRecord {
  const existing = getWebsiteProjectRecordByLeadId(leadId);
  if (existing) return existing;

  const db = getDb();
  const now = new Date().toISOString();
  const id = leadId;
  db.prepare(
    `INSERT OR IGNORE INTO website_projects (
       id, lead_id, current_version, status, created_at, updated_at
     ) VALUES (?, ?, 0, 'active', ?, ?)`,
  ).run(id, leadId, now, now);

  const record = getWebsiteProjectRecordByLeadId(leadId)!;
  return record;
}

function mountWorkspaceId(projectId: string, version: number): string {
  return `${projectId}-v${version}`;
}

/**
 * Creates the next version number for a project (MAX + 1) and inserts it as a
 * draft with a deterministic, isolated workspace id. The (project_id, version)
 * unique index plus a retry loop makes concurrent version creation safe: a
 * racing insert is re-detected and the version number is recomputed.
 */
export function createWebsiteProjectVersion(leadId: string): WebsiteVersionRow {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return withTransaction(() => {
        const db = getDb();
        const project = ensureWebsiteProject(leadId);
        const now = new Date().toISOString();
        const maxRow = db
          .prepare(
            "SELECT COALESCE(MAX(version), 0) AS version FROM website_versions WHERE project_id = ?",
          )
          .get(project.projectId) as { version: number };
        const version = Number(maxRow.version) + 1;

        const id = randomUUID();
        const workspaceId = mountWorkspaceId(project.projectId, version);
        db.prepare(
          `INSERT INTO website_versions (
             id, project_id, lead_id, version, status, website_project_json,
             is_current, build_status, qa_status, workspace_id, artifact_hash,
             metadata_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'draft', '{}', 0, 'pending', 'pending', ?, NULL, '{}', ?, ?)`,
        ).run(id, project.projectId, leadId, version, workspaceId, now, now);

        const row = db
          .prepare("SELECT * FROM website_versions WHERE id = ?")
          .get(id)!;
        return parseStored(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }
  throw new Error("Failed to create website project version: version conflict.");
}

// ---------------------------------------------------------------------------
// Version status lifecycle
// ---------------------------------------------------------------------------

const LEGAL_VERSION_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["building", "failed", "stopped"],
  building: ["qa", "failed", "stopped"],
  qa: ["ready", "failed", "stopped"],
  ready: ["current", "failed", "stopped"],
  current: ["ready", "failed", "stopped"],
  failed: [],
  stopped: [],
  completed: [],
};

export function isLegalVersionTransition(
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  return (LEGAL_VERSION_TRANSITIONS[from] ?? []).includes(to);
}

export class WebsiteVersionTransitionError extends Error {
  constructor(from: string, to: string) {
    super(
      `Illegal website version transition "${from}" -> "${to}".`,
    );
    this.name = "WebsiteVersionTransitionError";
  }
}

export interface VersionResultPatch {
  status?: WebsiteVersionStatus;
  buildStatus?: VersionBuildStatus;
  qaStatus?: VersionQaStatus;
  artifactHash?: string | null;
  workspaceId?: string | null;
  metadata?: Record<string, unknown>;
}

function applyResultPatch(
  current: string,
  build: VersionBuildStatus | null,
  qa: VersionQaStatus | null,
): string {
  const isIntermediate = ["draft", "building", "qa"].includes(current);
  if (build === "building" && current === "draft") return "building";
  if (isIntermediate && build === "success" && qa === "pass") return "ready";
  return current;
}

function mergeMetadata(
  existing: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
  db: ReturnType<typeof getDb>,
  versionId: string,
): Record<string, unknown> {
  if (!patch || Object.keys(patch).length === 0) return existing;
  const merged = { ...existing, ...patch };
  db.prepare("UPDATE website_versions SET metadata_json = ? WHERE id = ?").run(
    JSON.stringify(merged),
    versionId,
  );
  return merged;
}

/**
 * Applies a status/build/QA update to a version row with legal-transition
 * enforcement. Returns the refreshed row. Callers inside a transaction pass
 * the database handle so the update participates in the same transaction.
 */
export function updateWebsiteVersionResult(
  versionId: string,
  patch: VersionResultPatch,
): WebsiteVersionRow {
  return withTransaction(() => {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM website_versions WHERE id = ?")
      .get(versionId) as StoredRow | undefined;
    if (!row) {
      throw new Error(`Website version "${versionId}" not found.`);
    }

    const from = String(row.status);
    const derived =
      patch.status ?? applyResultPatch(from, patch.buildStatus ?? null, patch.qaStatus ?? null);
    const to = derived || from;

    if (patch.status && !isLegalVersionTransition(from, patch.status)) {
      throw new WebsiteVersionTransitionError(from, patch.status);
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.buildStatus !== undefined) {
      sets.push("build_status = ?");
      values.push(patch.buildStatus);
    }
    if (patch.qaStatus !== undefined) {
      sets.push("qa_status = ?");
      values.push(patch.qaStatus);
    }
    if (patch.artifactHash !== undefined) {
      sets.push("artifact_hash = ?");
      values.push(patch.artifactHash);
    }
    if (patch.workspaceId !== undefined) {
      sets.push("workspace_id = ?");
      values.push(patch.workspaceId);
    }
    if (to !== from) {
      sets.push("status = ?");
      values.push(to);
    }
    if (sets.length === 0) {
      return parseStored(row as StoredRow);
    }

    const now = new Date().toISOString();
    values.push(now, versionId);
    db.prepare(
      `UPDATE website_versions SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
    ).run(...values);

    const stored = db
      .prepare("SELECT * FROM website_versions WHERE id = ?")
      .get(versionId)!;
    const merged = mergeMetadata(parseStored(stored).metadata, patch.metadata, db, versionId);
    const finalStored = db
      .prepare("SELECT * FROM website_versions WHERE id = ?")
      .get(versionId)!;
    return { ...parseStored(finalStored), metadata: merged };
  });
}

export function markWebsiteVersionFailed(
  versionId: string,
  metadata?: Record<string, unknown>,
): WebsiteVersionRow {
  return updateWebsiteVersionResult(versionId, {
    status: "failed",
    metadata,
  });
}

export function markWebsiteVersionStopped(
  versionId: string,
): WebsiteVersionRow {
  return updateWebsiteVersionResult(versionId, { status: "stopped" });
}

function promotionGuard(row: WebsiteVersionRow): void {
  if (row.status !== "ready" && row.status !== "current") {
    throw new WebsiteVersionTransitionError(row.status, "current");
  }
  if (row.buildStatus !== "success") {
    throw new WebsiteVersionTransitionError(row.buildStatus ?? "pending", "current");
  }
  if (row.qaStatus !== "pass") {
    throw new WebsiteVersionTransitionError(row.qaStatus ?? "pending", "current");
  }
}

export class WebsitePromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebsitePromotionError";
  }
}

/**
 * Atomically promotes a version to the project's current version. Runs in a
 * single transaction: demotes any existing current version, marks the target
 * as current, and updates the project's current_version counter. Fails loudly
 * (no partial state) when the version is not promotable.
 */
export function promoteWebsiteVersion(
  versionId: string,
): WebsiteVersionRow {
  return withTransaction(() => {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM website_versions WHERE id = ?")
      .get(versionId) as StoredRow | undefined;
    if (!row) {
      throw new WebsitePromotionError(
        `Website version "${versionId}" not found.`,
      );
    }
    const version = parseStored(row);
    if (!version.websiteProjectId) {
      throw new WebsitePromotionError(
        "Version is not bound to a website project.",
      );
    }
    promotionGuard(version);

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE website_versions
       SET is_current = 0, status = 'ready', updated_at = ?
       WHERE project_id = ? AND is_current = 1 AND id != ?`,
    ).run(now, version.websiteProjectId, versionId);

    db.prepare(
      `UPDATE website_versions
       SET is_current = 1, status = 'current', updated_at = ? WHERE id = ?`,
    ).run(now, versionId);

    db.prepare(
      `UPDATE website_projects
       SET current_version = ?, status = 'active', updated_at = ? WHERE id = ?`,
    ).run(version.version, now, version.websiteProjectId);

    const stored = db
      .prepare("SELECT * FROM website_versions WHERE id = ?")
      .get(versionId)!;
    return parseStored(stored);
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function listWebsiteProjectVersions(
  websiteProjectId: string,
): WebsiteVersionRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM website_versions WHERE project_id = ? ORDER BY version ASC",
    )
    .all(websiteProjectId) as StoredRow[];
  return rows.map(parseStored);
}

export function getCurrentWebsiteVersion(
  leadId: string,
): WebsiteVersionRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM website_versions
       WHERE lead_id = ? AND is_current = 1
       ORDER BY version DESC LIMIT 1`,
    )
    .get(leadId);
  return row ? parseStored(row) : null;
}

export interface WebsiteProjectDetail {
  project: WebsiteProjectRecord;
  versions: WebsiteVersionRow[];
  currentVersion: WebsiteVersionRow | null;
}

export function getWebsiteProjectDetail(
  leadId: string,
): WebsiteProjectDetail | null {
  const project = getWebsiteProjectRecordByLeadId(leadId);
  if (!project) return null;
  return {
    project,
    versions: listWebsiteProjectVersions(project.projectId),
    currentVersion: getCurrentWebsiteVersion(leadId),
  };
}

// ---------------------------------------------------------------------------
// Legacy compatibility layer (unchanged behavior)
// ---------------------------------------------------------------------------

export function getWebsiteProject(projectId: string): WebsiteProject | null {
  const version = getWebsiteVersion(projectId);
  return version?.project ?? null;
}

export function getWebsiteVersion(projectId: string): WebsiteVersionRow | null {
  const row = getDb()
    .prepare("SELECT * FROM website_versions WHERE id = ?")
    .get(projectId);
  return row ? parseStored(row) : null;
}

export function getLatestWebsiteVersion(leadId: string): WebsiteVersionRow | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM website_versions WHERE lead_id = ? ORDER BY version DESC LIMIT 1",
    )
    .get(leadId);
  return row ? parseStored(row) : null;
}

export function countWebsiteVersions(leadId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM website_versions WHERE lead_id = ?")
    .get(leadId) as { count: number };
  return Number(row.count);
}

export function listWebsiteVersions(leadId: string): WebsiteVersionRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM website_versions WHERE lead_id = ? ORDER BY version ASC",
    )
    .all(leadId) as StoredRow[];
  return rows.map(parseStored);
}

export function createWebsiteVersion(
  leadId: string,
  project: WebsiteProject,
): WebsiteVersionRow {
  // The (lead_id, version) unique index makes close-to-simultaneous version
  // creation safe; if a conflicting version number was already inserted in a
  // concurrent transaction, recompute from the new MAX value and retry.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return withTransaction(() => {
        const db = getDb();
        const now = new Date().toISOString();
        const maxRow = db
          .prepare(
            "SELECT COALESCE(MAX(version), 0) AS version FROM website_versions WHERE lead_id = ?",
          )
          .get(leadId) as { version: number };
        const version = Number(maxRow.version) + 1;

        db.prepare(
          "UPDATE website_versions SET is_current = 0 WHERE lead_id = ?",
        ).run(leadId);
        db.prepare(
          `INSERT INTO website_versions (id, lead_id, version, status, website_project_json, is_current, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(
          project.projectId,
          leadId,
          version,
          "completed",
          JSON.stringify(project),
          now,
          now,
        );

        const row = db
          .prepare("SELECT * FROM website_versions WHERE id = ?")
          .get(project.projectId)!;
        return parseStored(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }
  throw new Error("Failed to persist website version: version conflict.");
}