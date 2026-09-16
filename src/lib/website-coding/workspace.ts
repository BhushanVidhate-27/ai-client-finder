/**
 * Isolated website workspace for the Website Coding Agent.
 *
 * Every generated website lives under `workspaces/<project-id>/`. All reads,
 * writes and deletes are confined to that directory by construction:
 *
 *   - the project id must be a plain slug (no separators, dots, or traversal)
 *   - relative paths must not be absolute, must not contain ".." or backslash
 *   - the resolved path must stay inside the workspace directory
 *
 * Nothing here ever touches src/app, src/lib, .env*, the database, or any
 * other application directory. No shell commands are executed — only bounded
 * node:fs operations on paths that have passed the safety checks.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export class WorkspaceProjectIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceProjectIdError";
  }
}

const SAFE_PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;

const DEFAULT_WORKSPACES_ROOT = path.resolve(process.cwd(), "workspaces");

export function resolveWorkspacesRoot(): string {
  const fromEnv = process.env.WORKSPACES_ROOT;
  return fromEnv ? path.resolve(fromEnv) : DEFAULT_WORKSPACES_ROOT;
}

/** Validates a project id used as a workspace directory name. */
export function assertSafeProjectId(projectId: string): string {
  const trimmed = projectId.trim();
  if (!SAFE_PROJECT_ID.test(trimmed)) {
    throw new WorkspaceProjectIdError(
      `Invalid workspace project id "${projectId}". Use a plain slug ([a-zA-Z0-9_-]).`,
    );
  }
  return trimmed;
}

/**
 * Validates a workspace-relative path and returns the resolved absolute path
 * inside the workspace. Rejects absolute paths, ".." segments, backslashes,
 * and anything that would escape the workspace root.
 */
export function resolveWorkspacePath(
  projectId: string,
  relPath: string,
): string {
  const id = assertSafeProjectId(projectId);
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new WorkspacePathError("Workspace file path must not be empty.");
  }
  if (relPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new WorkspacePathError(
      `Absolute paths are not allowed in a workspace: "${relPath}".`,
    );
  }
  if (relPath.includes("\\")) {
    throw new WorkspacePathError(
      `Backslashes are not allowed in workspace paths: "${relPath}".`,
    );
  }
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new WorkspacePathError(
        `".." is not allowed in workspace paths: "${relPath}".`,
      );
    }
    if (segment.includes("\0") || segment.trim() === "") {
      throw new WorkspacePathError(
        `Invalid segment in workspace path: "${relPath}".`,
      );
    }
  }

  const root = workspaceDir(id);
  const resolved = path.join(root, ...segments);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(rootWithSep)) {
    throw new WorkspacePathError(
      `Path escapes the workspace: "${relPath}".`,
    );
  }
  return resolved;
}

/** Absolute path to the workspace directory for a project id. */
export function workspaceDir(projectId: string): string {
  const id = assertSafeProjectId(projectId);
  return path.join(resolveWorkspacesRoot(), id);
}

/** True when a path safety check passes without throwing. */
export function isSafeWorkspaceRelativePath(relPath: string): boolean {
  try {
    resolveWorkspacePath("__probe__", relPath);
    return true;
  } catch {
    return false;
  }
}

export interface WorkspaceFileEntry {
  path: string;
  bytes: number;
}

/** Creates the workspace directory (idempotent). */
export async function ensureWorkspace(projectId: string): Promise<string> {
  const dir = workspaceDir(projectId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Removes the entire workspace directory. */
export async function deleteWorkspace(projectId: string): Promise<void> {
  const dir = workspaceDir(projectId);
  await rm(dir, { recursive: true, force: true });
}

/** Lists all files (recursively) inside a workspace as relative paths. */
export async function listWorkspaceFiles(
  projectId: string,
): Promise<WorkspaceFileEntry[]> {
  const dir = workspaceDir(projectId);
  // Fail loudly when the workspace itself is missing so callers can detect
  // "does not exist" instead of mistaking an empty workspace for a missing one.
  await stat(dir);
  const entries: WorkspaceFileEntry[] = [];
  await walkDirectory(dir, dir, entries);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function walkDirectory(
  root: string,
  current: string,
  entries: WorkspaceFileEntry[],
): Promise<void> {
  let children: string[];
  try {
    children = await readdir(current);
  } catch {
    return;
  }
  for (const child of children) {
    const abs = path.join(current, child);
    let info: Stats;
    try {
      info = await stat(abs);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      await walkDirectory(root, abs, entries);
    } else if (info.isFile()) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      entries.push({ path: rel, bytes: info.size });
    }
  }
}

/** Reads a single file's contents from inside the workspace. */
export async function readWorkspaceFile(
  projectId: string,
  relPath: string,
): Promise<string> {
  const resolved = resolveWorkspacePath(projectId, relPath);
  return readFile(resolved, "utf8");
}

export interface WorkspaceFileWithContent extends WorkspaceFileEntry {
  content: string;
}

/** Reads every file in the workspace together with its contents. */
export async function getWorkspaceFilesWithContent(
  projectId: string,
): Promise<WorkspaceFileWithContent[]> {
  const entries = await listWorkspaceFiles(projectId);
  const withContent: WorkspaceFileWithContent[] = [];
  for (const entry of entries) {
    const resolved = resolveWorkspacePath(projectId, entry.path);
    try {
      const content = await readFile(resolved, "utf8");
      withContent.push({ ...entry, content });
    } catch {
      // Skip unreadable files; the validator will flag missing required ones.
    }
  }
  return withContent;
}

const BUILD_JSON = "build.json";
const BUILD_ERRORS_JSON = "build-errors.json";

/**
 * Writes a build manifest (success) or error manifest (failure) into the
 * workspace, keeping the two mutually exclusive.
 */
export async function writeBuildManifest(
  projectId: string,
  result: { status: string },
): Promise<void> {
  const dir = workspaceDir(projectId);
  await mkdir(dir, { recursive: true });
  if (result.status === "success") {
    await writeFile(
      path.join(dir, BUILD_JSON),
      JSON.stringify(result, null, 2),
      "utf8",
    );
    await rm(path.join(dir, BUILD_ERRORS_JSON), { force: true });
  } else {
    await writeFile(
      path.join(dir, BUILD_ERRORS_JSON),
      JSON.stringify(result, null, 2),
      "utf8",
    );
    await rm(path.join(dir, BUILD_JSON), { force: true });
  }
}

/** Reads build.json if present. */
export async function readBuildManifest(
  projectId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readWorkspaceFile(projectId, BUILD_JSON);
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Reads build-errors.json if present. */
export async function readBuildErrorsManifest(
  projectId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readWorkspaceFile(projectId, BUILD_ERRORS_JSON);
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Writes one or more files inside the workspace, creating parent dirs. */
export async function writeWorkspaceFiles(
  projectId: string,
  files: Array<{ path: string; content: string }>,
): Promise<string[]> {
  const root = workspaceDir(projectId);
  await mkdir(root, { recursive: true });
  const written: string[] = [];
  for (const file of files) {
    const resolved = resolveWorkspacePath(projectId, file.path);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, file.content, "utf8");
    written.push(file.path);
  }
  return written;
}

/** Deletes a single file inside the workspace (no-op when missing). */
export async function deleteWorkspaceFile(
  projectId: string,
  relPath: string,
): Promise<void> {
  const resolved = resolveWorkspacePath(projectId, relPath);
  await rm(resolved, { force: true });
}