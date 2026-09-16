import { createHash } from "node:crypto";
import { getWorkspaceFilesWithContent } from "@/lib/website-coding/workspace";

/**
 * Deterministic SHA-256 over the full source artifact of a website version.
 *
 * The input file list is sorted by path before hashing and every entry is
 * encoded as `<path>\0<content>\0`, so two artifacts hash equal if and only if
 * they contain the exact same file set with the exact same contents. No
 * timestamps, random ids, environment values, or filesystem metadata are ever
 * folded in — regenerating from an identical source always yields the same
 * hash, and changing a single byte changes the hash.
 */
export function computeSourceHash(
  files: Array<{ path: string; content: string }>,
): string {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const hash = createHash("sha256");
  for (const file of sorted) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Computes the deterministic source hash of a workspace directory's files.
 */
export async function hashWorkspace(projectId: string): Promise<string> {
  const files = await getWorkspaceFilesWithContent(projectId);
  return computeSourceHash(files);
}