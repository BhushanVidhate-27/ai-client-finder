import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  getCurrentWebsiteVersion,
  getWebsiteProjectRecordByLeadId,
} from "@/lib/data/websites";
import {
  listWorkspaceFiles,
  readBuildManifest,
  workspaceDir,
  WorkspacePathError,
} from "@/lib/website-coding/workspace";
import { hashWorkspace } from "@/lib/website-coding/source-hash";
import {
  DeploymentIneligibleError,
  DeploymentTimeoutError,
} from "@/lib/deployment/errors";
import type { DeployableArtifact, DeploymentStatus } from "@/lib/deployment/types";

// ---------------------------------------------------------------------------
// Artifact packaging (Step 13)
// ---------------------------------------------------------------------------

const BLOCKED_FILENAMES = new Set([
  "build.json",
  "build-errors.json",
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
]);

function shouldExclude(filePath: string): boolean {
  const parts = filePath.split("/");
  const basename = parts[parts.length - 1];
  if (basename.startsWith(".")) return true;
  if (BLOCKED_FILENAMES.has(basename)) return true;
  if (/^\.env/i.test(basename)) return true;
  if (/\.(db|sqlite|sqlite3|key|pem|crt)$/.test(basename)) return true;
  return false;
}

/**
 * Deterministic artifact packaging.
 *
 * Reads only the approved version workspace and includes every file that
 * passes the safe allowlist. Files are sorted by path for determinism;
 * nothing is modified, renamed, or mutated. The hash returned is a
 * deterministic SHA-256 over the packaged files — the same call on the
 * same workspace always yields the same hash and artifact.
 */
export async function packageDeployment(
  workspaceId: string,
): Promise<DeployableArtifact> {
  const entries = await listWorkspaceFiles(workspaceId);
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    if (shouldExclude(entry.path)) continue;
    try {
      const content = await readFile(
        path.join(workspaceDir(workspaceId), entry.path),
        "utf8",
      );
      files.push({ path: entry.path, content });
    } catch {
      continue;
    }
  }
  const hash = hashPackage(files);
  return { files, hash };
}

function hashPackage(
  files: Array<{ path: string; content: string }>,
): string {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const h = createHash("sha256");
  for (const file of sorted) {
    h.update(file.path);
    h.update("\0");
    h.update(file.content);
    h.update("\0");
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Deployment eligibility verification
// ---------------------------------------------------------------------------

export interface DeploymentEligibility {
  websiteProjectId: string;
  versionId: string;
  version: number;
  leadId: string;
  workspaceId: string;
  artifactHash: string;
}

/**
 * Verifies server-side that a lead's current website version may be deployed.
 *
 * Checks are derived entirely from trusted database records and the actual
 * workspace content. Client-supplied status, build/QA flags, and paths are
 * never trusted. Throws `DeploymentIneligibleError` with a safe reason on
 * any failure.
 */
export async function verifyVersionEligible(
  leadId: string,
  requestedVersionId?: string,
): Promise<DeploymentEligibility> {
  const project = getWebsiteProjectRecordByLeadId(leadId);
  if (!project) {
    throw new DeploymentIneligibleError(
      `No website project exists for lead "${leadId}".`,
    );
  }

  const current = getCurrentWebsiteVersion(leadId);
  if (!current) {
    throw new DeploymentIneligibleError(
      "No website version has been generated yet.",
    );
  }

  if (requestedVersionId && requestedVersionId !== current.projectId) {
    throw new DeploymentIneligibleError(
      "Requested version is not the current verified version.",
    );
  }

  if (current.status !== "current") {
    throw new DeploymentIneligibleError(
      "Version is not the current version.",
    );
  }

  if (current.buildStatus !== "success") {
    throw new DeploymentIneligibleError(
      "Build has not passed; deployment is not permitted.",
    );
  }

  if (current.qaStatus !== "pass") {
    throw new DeploymentIneligibleError(
      "QA has not passed; deployment is not permitted.",
    );
  }

  if (!current.artifactHash) {
    throw new DeploymentIneligibleError(
      "No artifact hash has been recorded; final verification has not completed.",
    );
  }

  if (!current.workspaceId) {
    throw new DeploymentIneligibleError(
      "Version workspace is not present; deployment is not permitted.",
    );
  }

  let manifest: Record<string, unknown> | null = null;
  try {
    manifest = await readBuildManifest(current.workspaceId);
  } catch {
    throw new DeploymentIneligibleError(
      "Workspace is not accessible.",
    );
  }

  if (!manifest || manifest.status !== "success") {
    throw new DeploymentIneligibleError(
      "Build manifest is missing or does not indicate success.",
    );
  }

  let rehash: string;
  try {
    rehash = await hashWorkspace(current.workspaceId);
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      throw new DeploymentIneligibleError(
        "Workspace path is invalid or inaccessible.",
      );
    }
    throw error;
  }

  if (rehash !== current.artifactHash) {
    throw new DeploymentIneligibleError(
      "Artifact hash mismatch: the workspace was modified after QA.",
    );
  }

  return {
    websiteProjectId: project.projectId,
    versionId: current.projectId,
    version: current.version,
    leadId: current.leadId,
    workspaceId: current.workspaceId,
    artifactHash: rehash,
  };
}

// ---------------------------------------------------------------------------
// Deployment status polling
// ---------------------------------------------------------------------------

const POLL_TERMINAL: DeploymentStatus[] = ["ready", "failed", "cancelled"];

export function isTerminalDeployment(status: DeploymentStatus): boolean {
  return POLL_TERMINAL.includes(status);
}

export const MAX_POLL_ATTEMPTS = 60;
export const POLL_INTERVAL_MS = 2000;
export const DEPLOYMENT_TIMEOUT_MS = 15 * 60 * 1000;

export async function pollDeploymentUntilTerminal(
  adapter: {
    getDeploymentStatus(
      handle: { providerDeploymentId: string },
    ): Promise<{ status: DeploymentStatus; url: string | null; message: string | null }>;
  },
  handle: { providerDeploymentId: string },
  opts?: { maxAttempts?: number; intervalMs?: number; totalTimeoutMs?: number },
): Promise<{ status: DeploymentStatus; url: string | null; message: string | null }> {
  const maxAttempts = opts?.maxAttempts ?? MAX_POLL_ATTEMPTS;
  const intervalMs = opts?.intervalMs ?? POLL_INTERVAL_MS;
  const totalTimeoutMs = opts?.totalTimeoutMs ?? DEPLOYMENT_TIMEOUT_MS;
  const deadline = Date.now() + totalTimeoutMs;
  let last = await adapter.getDeploymentStatus(handle);
  for (let i = 1; i < maxAttempts && !isTerminalDeployment(last.status); i += 1) {
    if (Date.now() >= deadline) {
      throw new DeploymentTimeoutError("provider");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await adapter.getDeploymentStatus(handle);
  }
  if (!isTerminalDeployment(last.status)) {
    throw new DeploymentTimeoutError("provider");
  }
  return last;
}