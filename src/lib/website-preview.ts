import { getWebsiteVersion } from "@/lib/data/websites";
import {
  readWorkspaceFile,
  isSafeWorkspaceRelativePath,
} from "@/lib/website-coding/workspace";

/**
 * Workspace-backed preview for Step 12 website versions.
 *
 * Legacy versions carry their full website project (including rendered files)
 * in the database. Step 12 versions instead keep the generated source only in
 * their isolated workspace and store metadata in the database — this module
 * resolves those versions for preview by reading files straight out of the
 * workspace, using the same path-safety checks the coding/QA agents rely on.
 *
 * Only a small allowlist of content types is served, and operational build
 * manifests / dotfiles are never exposed, so the public preview route cannot
 * leak database files, environment files, or any non-artifact server content.
 */

const BLOCKED_PATHS = new Set(["build.json", "build-errors.json"]);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function contentTypeFor(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf("."));
  return CONTENT_TYPES[extension] ?? null;
}

/** Resolves the workspace id for a Step 12 version, or null when legacy. */
export function getWorkspacePreview(
  versionId: string,
): { workspaceId: string } | null {
  const version = getWebsiteVersion(versionId);
  if (!version || !version.workspaceId) return null;
  return { workspaceId: version.workspaceId };
}

/**
 * Candidate workspace-relative file paths for a preview URL.
 * `/` -> index.html, `/services` -> services.html (with fallbacks).
 */
function candidatePaths(segments: string[]): string[] {
  if (!segments || segments.length === 0) return ["index.html"];
  const joined = segments.join("/");
  if (joined.endsWith("/")) return [`${joined}index.html`];
  if (BLOCKED_PATHS.has(joined)) return [];
  if (joined.startsWith(".")) return [];
  if (contentTypeFor(joined) !== null) return [joined];
  return [
    joined.endsWith(".html") ? joined : `${joined}.html`,
    joined,
    joined.endsWith("/index.html") ? joined : `${joined}/index.html`,
  ];
}

/** Reads and (for HTML) rewrites internal references for preview. */
export async function readWorkspacePreview(
  versionId: string,
  segments: string[],
): Promise<{ content: string; contentType: string } | null> {
  const workspace = getWorkspacePreview(versionId);
  if (!workspace) return null;

  for (const candidate of candidatePaths(segments)) {
    if (!isSafeWorkspaceRelativePath(candidate)) continue;
    if (BLOCKED_PATHS.has(candidate) || candidate.startsWith(".")) continue;
    const contentType = contentTypeFor(candidate);
    if (!contentType) continue;
    try {
      const content = await readWorkspaceFile(workspace.workspaceId, candidate);
      if (contentType.startsWith("text/html")) {
        return {
          content: rewriteInternalRefs(content, versionId),
          contentType,
        };
      }
      return { content, contentType };
    } catch {
      // Fall through to the next candidate.
    }
  }
  return null;
}

function rewriteInternalRefs(html: string, versionId: string): string {
  return html.replace(
    /(href|src)\s*=\s*("[^"]*"|'[^']*')/gi,
    (whole, attr: string, rawValue: string) => {
      const quote = rawValue[0];
      const value = rawValue.slice(1, -1).trim();
      if (!value) return whole;
      if (
        /^(https?:|mailto:|tel:|data:|javascript:|#|\/\/)/i.test(value)
      ) {
        return whole;
      }
      const prefixed = value.startsWith("/")
        ? `/preview/${versionId}${value}`
        : `/preview/${versionId}/${value}`;
      return `${attr}=${quote}${prefixed}${quote}`;
    },
  );
}