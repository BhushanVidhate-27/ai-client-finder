import type {
  QaFix,
  QaFixReport,
  QaIssue,
  QaResult,
} from "./types";
import type { WorkspaceFileWithContent } from "@/lib/website-coding/workspace";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plan a batch of fixes for every fixable issue in the audit result. Each
 * QaFix carries enough information to apply deterministically from the file
 * content alone.
 */
export function planFixes(
  audit: QaResult,
  files: WorkspaceFileWithContent[],
): QaFix[] {
  const fileMap = new Map(files.map((f) => [f.path, f.content]));
  const routes = new Set<string>();
  for (const f of files) {
    if (f.path.endsWith(".html")) {
      routes.add(f.path);
      routes.add(`/${f.path}`);
      routes.add(`/${f.path.replace(/\.html$/, "")}`);
    }
  }

  const fixes: QaFix[] = [];
  for (const issue of audit.issues) {
    if (!issue.fixable) continue;
    const planned = planSingle(issue, fileMap, routes);
    if (planned) fixes.push(planned);
  }
  return fixes;
}

/**
 * Apply a planned batch of fixes to the provided file contents, returning the
 * list of changed files (content still writable by the caller).
 */
export function applyFixes(
  files: WorkspaceFileWithContent[],
  fixes: QaFix[],
): QaFixReport {
  const contentMap = new Map(files.map((f) => [f.path, f.content]));
  const applied: QaFix[] = [];
  const failed: QaFix[] = [];

  for (const fix of fixes) {
    const content = contentMap.get(fix.file);
    if (content == null) {
      failed.push(fix);
      continue;
    }
    const result = applySingle(content, fix);
    if (result !== null) {
      contentMap.set(fix.file, result);
      applied.push(fix);
    } else {
      failed.push(fix);
    }
  }

  const changedFiles: QaFixReport["changedFiles"] = [];
  for (const [path, content] of contentMap) {
    const original = files.find((f) => f.path === path)?.content ?? null;
    if (original !== null && content !== original) {
      changedFiles.push({ path, content });
    }
  }

  return { applied, failed, changedFiles };
}

// ---------------------------------------------------------------------------
// Single-issue fix planning
// ---------------------------------------------------------------------------

function planSingle(
  issue: QaIssue,
  _fileMap: Map<string, string>,
  _routes: Set<string>,
): QaFix | null {
  const file = issue.file ?? "index.html";
  if (!issue.fixKind) return null;

  switch (issue.fixKind) {
    case "remove-element":
    case "remove-contact-item":
    case "remove-service-card":
    case "remove-testimonial":
      return { issueId: issue.id, kind: issue.fixKind, file, target: issue.evidence };

    case "remove-sentence":
      return { issueId: issue.id, kind: "remove-sentence", file, target: issue.evidence };

    case "fix-internal-link": {
      const candidate = relinkCandidate(issue.evidence, _routes);
      if (!candidate) return null;
      return { issueId: issue.id, kind: "fix-internal-link", file, target: issue.evidence, replacement: candidate };
    }

    case "add-alt":
      return { issueId: issue.id, kind: "add-alt", file, target: issue.evidence, replacement: "Image" };

    case "add-viewport":
      return { issueId: issue.id, kind: "add-viewport", file, target: "<head>", replacement: "viewport-injected" };
  }
}

// ---------------------------------------------------------------------------
// Single fix application (pure function: content + fix -> new content | null)
// ---------------------------------------------------------------------------

function applySingle(content: string, fix: QaFix): string | null {
  switch (fix.kind) {
    case "remove-element":
      return removeAnchorContainingText(content, fix.target) ?? null;
    case "remove-contact-item":
      return removeListItemContainingText(content, fix.target) ?? null;
    case "remove-service-card":
      return removeCardByTitle(content, fix.target) ?? null;
    case "remove-testimonial":
      return removeBlockquote(content) ?? null;
    case "remove-sentence":
      return removeSentence(content, fix.target) ?? null;
    case "fix-internal-link":
      return fixBrokenHref(content, fix.target, fix.replacement ?? "") ?? null;
    case "add-alt":
      return addAltToFirstBareImage(content) ?? null;
    case "add-viewport":
      return injectViewport(content) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Remove operations
// ---------------------------------------------------------------------------

function removeAnchorContainingText(content: string, text: string): string | null {
  const idx = content.indexOf(text);
  if (idx < 0) return null;
  const before = content.lastIndexOf("<a", idx);
  if (before < 0) return null;
  const after = content.indexOf("</a>", idx);
  if (after < 0) return null;
  const end = after + "</a>".length;
  return collapse(resultTrim(content.slice(0, before) + content.slice(end)));
}

function removeListItemContainingText(content: string, text: string): string | null {
  const idx = content.indexOf(text);
  if (idx < 0) return null;
  const before = content.lastIndexOf("<li", idx);
  if (before < 0) return removeAnchorContainingText(content, text);
  const after = content.indexOf("</li>", idx);
  if (after < 0) return null;
  const end = after + "</li>".length;
  return collapse(resultTrim(content.slice(0, before) + content.slice(end)));
}

function removeCardByTitle(content: string, title: string): string | null {
  const escaped = escapeRegexForHtml(title);
  const cardRe = new RegExp(
    `<article\\s+class="card">[\\s\\S]*?<h3[^>]*>(?:<[^>]*>)*\\s*${escaped}\\s*(?:<[^>]*>)*<\\/h3>[\\s\\S]*?<\\/article>`,
    "i",
  );
  const m = content.match(cardRe);
  if (!m) return null;
  return collapse(resultTrim(content.replace(cardRe, "")));
}

function removeBlockquote(content: string): string | null {
  const bqRe = /<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi;
  const m = content.match(bqRe);
  if (!m) return null;
  return collapse(resultTrim(content.replace(bqRe, "")));
}

function removeSentence(content: string, sentence: string): string | null {
  if (!sentence || sentence.length < 3) return null;
  const escaped = escapeRegexForHtml(sentence);
  const re = new RegExp(escaped, "i");
  const m = content.match(re);
  if (!m) return null;
  const cleaned = content.replace(re, "");
  return collapse(resultTrim(cleaned));
}

// ---------------------------------------------------------------------------
// Fix operations
// ---------------------------------------------------------------------------

function fixBrokenHref(
  content: string,
  brokenHref: string,
  replacement: string,
): string | null {
  if (!brokenHref || !replacement) return null;
  // Handle both quoted forms.
  let newContent = content.replace(
    new RegExp(
      `(href\\s*=\\s*["'])(?:${escapeRegexForHtml(brokenHref)})(["'])`,
      "i",
    ),
    `$1${escapeHtml(replacement)}$2`,
  );
  if (newContent === content) {
    // Without query/hash stripping
    newContent = content.replace(
      new RegExp(
        `(href\\s*=\\s*["'])${escapeRegexForHtml(brokenHref)}(["'])`,
        "i",
      ),
      `$1${escapeHtml(replacement)}$2`,
    );
  }
  return newContent === content ? null : newContent;
}

function addAltToFirstBareImage(content: string): string | null {
  // Match <img ...> without an existing alt attribute.
  const re = /<img\b((?![^>]*\balt=)[^>]*?)\/?>/i;
  const m = content.match(re);
  if (!m) return null;
  const newContent = content.replace(re, '<img alt="Image"$1>');
  return newContent === content ? null : newContent;
}

function injectViewport(content: string): string | null {
  if (/name=["']viewport["']/i.test(content)) return null;
  const afterCharset = content.indexOf("<meta charset");
  if (afterCharset < 0) return null;
  const insertAt = content.indexOf("/>", afterCharset) + 2;
  const viewportTag = `\n  <meta name="viewport" content="width=device-width, initial-scale=1" />`;
  return content.slice(0, insertAt) + viewportTag + content.slice(insertAt);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegexForHtml(value: string): string {
  const escaped = value
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\//g, "\\/")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return escaped;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function relinkCandidate(
  href: string,
  routes: Set<string>,
): string | null {
  const raw = href.split(/[?#]/)[0];
  if (!raw) return null;
  if (raw === "/") return "index.html";
  const cleaned = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleaned) return null;
  let target = cleaned;
  if (!cleaned.endsWith(".html") && !cleaned.includes(".")) {
    target = cleaned + ".html";
  }
  if (routes.has(target) || routes.has("/" + target)) return target;
  if (!cleaned.endsWith(".html") && routes.has(cleaned + ".html")) {
    return cleaned + ".html";
  }
  return null;
}

/** Remove empty heading/paragraph elements left by deletions. */
function collapse(content: string): string {
  let prev = content;
  let result = prev;
  do {
    prev = result;
    result = result
      .replace(/<h[1-6][^>]*>\s*<\/h[1-6]>/gi, "")
      .replace(/<p[^>]*>\s*<\/p>/gi, "")
      .replace(/<article class="card">\s*<\/article>/gi, "")
      .replace(/<li>\s*<\/li>/gi, "")
      .replace(/\n\s*\n\s*\n/g, "\n");
  } while (result !== prev);
  return result.trim();
}

/** Light final cleanup. */
function resultTrim(content: string): string {
  return content.replace(/[ \t]+$/gm, "");
}