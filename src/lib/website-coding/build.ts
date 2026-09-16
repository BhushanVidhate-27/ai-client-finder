/**
 * Deterministic build + validation for generated websites.
 *
 * There is intentionally no shell and no external tooling: "build" validates
 * the generated static site and records either `build.json` (success) or
 * `build-errors.json` (failure) inside the workspace. Running this on a
 * workspace is side-effect limited to those two manifest files so the agent's
 * verify step can inspect a durable, deterministic record of build health.
 */

import {
  getWorkspaceFilesWithContent,
  workspaceDir,
  writeBuildManifest,
} from "@/lib/website-coding/workspace";

export type BuildErrorCode =
  | "missing-file"
  | "broken-link"
  | "malformed-html"
  | "forbidden-content"
  | "unknown-error";

export interface BuildFinding {
  file: string;
  code: BuildErrorCode;
  message: string;
}

export interface BuildSuccess {
  status: "success";
  projectId: string;
  workspace: string;
  files: Array<{ path: string; bytes: number }>;
  builtAt: string;
}

export interface BuildFailure {
  status: "error";
  projectId: string;
  workspace: string;
  errors: BuildFinding[];
  builtAt: string;
}

export type BuildResult = BuildSuccess | BuildFailure;

export const BASE_REQUIRED_FILES = [
  "index.html",
  "styles.css",
  "script.js",
  "package.json",
];

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Conversion from an internal path like "/services.html" to a workspace file. */
function internalPathToFile(link: string): string | null {
  if (link === "/") return "index.html";
  const clean = link.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return "index.html";
  if (clean.endsWith(".html")) return clean;
  // Extension-less internal links are treated as pages.
  if (!clean.includes(".")) return `${clean}.html`;
  return clean;
}

function validateHtml(
  html: string,
  fileName: string,
  existing: Set<string>,
  errors: BuildFinding[],
): void {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");

  const inlineJs = withoutComments.match(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/gi);
  if (inlineJs && inlineJs.some((block) => /lorem ipsum/i.test(block))) {
    errors.push({
      file: fileName,
      code: "forbidden-content",
      message: "Lipsum placeholder found in inline script.",
    });
  }

  const hrefs = withoutComments.match(/href\s*=\s*("[^"]*"|'[^']*')/gi) ?? [];
  for (const href of hrefs) {
    const value = (href.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") || "").trim();
    if (!value) continue;
    if (/^javascript:/i.test(value) || /^data:/i.test(value) || value.startsWith("//")) {
      errors.push({
        file: fileName,
        code: "forbidden-content",
        message: `Unsafe URL in href: "${value}".`,
      });
      continue;
    }
    if (value.startsWith("/") && !value.startsWith("//")) {
      const target = internalPathToFile(value);
      if (target && !existing.has(target)) {
        errors.push({
          file: fileName,
          code: "broken-link",
          message: `Internal link "${value}" targets missing file "${target}".`,
        });
      }
    }
  }

  const stack: Array<{ tag: string }> = [];
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(withoutComments)) !== null) {
    const token = match[0];
    const tagName = match[1].toLowerCase();
    if (token.startsWith("</")) {
      const open = stack.pop();
      if (!open || open.tag !== tagName) {
        errors.push({
          file: fileName,
          code: "malformed-html",
          message: `Unbalanced <${tagName}> tag.`,
        });
        return;
      }
    } else if (!VOID_ELEMENTS.has(tagName) && !token.endsWith("/>")) {
      stack.push({ tag: tagName });
    }
  }
  if (stack.length > 0) {
    errors.push({
      file: fileName,
      code: "malformed-html",
      message: `Unclosed tag <${stack[stack.length - 1].tag}>.`,
    });
  }
}

/** Validates an existing workspace. Purely read-only — no file writes. */
export async function validateWorkspace(
  projectId: string,
  requiredFiles: string[] = BASE_REQUIRED_FILES,
): Promise<BuildResult> {
  const workspace = workspaceDir(projectId);
  const required = new Set<string>([
    ...BASE_REQUIRED_FILES,
    ...requiredFiles.filter((f) => !BASE_REQUIRED_FILES.includes(f)),
  ]);
  const files = await getWorkspaceFilesWithContent(projectId);
  const existing = new Set(files.map((file) => file.path));

  const errors: BuildFinding[] = [];
  for (const file of required) {
    if (!existing.has(file)) {
      errors.push({
        file,
        code: "missing-file",
        message: `Required file "${file}" does not exist.`,
      });
    }
  }

  for (const file of files) {
    if (/lorem ipsum/i.test(file.content)) {
      errors.push({
        file: file.path,
        code: "forbidden-content",
        message: "Lipsum placeholder found in file.",
      });
    }
    if (file.path.endsWith(".html")) {
      validateHtml(file.content, file.path, existing, errors);
    }
  }

  if (errors.length > 0) {
    return {
      status: "error",
      projectId,
      workspace,
      errors,
      builtAt: new Date().toISOString(),
    };
  }

  return {
    status: "success",
    projectId,
    workspace,
    files: files
      .filter((file) => required.has(file.path))
      .map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, "utf8") })),
    builtAt: new Date().toISOString(),
  };
}

/** Builds the workspace (validate + write manifest) or its error manifest. */
export async function buildWorkspace(
  projectId: string,
  requiredFiles: string[] = BASE_REQUIRED_FILES,
): Promise<BuildResult> {
  const result = await validateWorkspace(projectId, requiredFiles);
  await writeBuildManifest(projectId, result);
  return result;
}

/** Read-only validation used by the website.validate tool. */
export async function validateWorkspaceReadOnly(
  projectId: string,
  requiredFiles: string[] = BASE_REQUIRED_FILES,
): Promise<BuildResult> {
  return validateWorkspace(projectId, requiredFiles);
}