import { getWebsiteProject } from "@/lib/website-store";
import { renderPageDocument } from "@/lib/website-render";
import { readWorkspacePreview } from "@/lib/website-preview";

export const dynamic = "force-dynamic";

function notFoundHtml(projectExists: boolean): string {
  const message = projectExists
    ? "This page does not exist in the generated website."
    : "This preview could not be found.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Page not found</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; color: #334155; background: #f8fafc; text-align: center; padding: 2rem; }
    p { color: #64748b; max-width: 400px; margin: 0.75rem auto 0; line-height: 1.6; }
  </style>
</head>
<body>
  <div>
    <h1>Page not found</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; path: string[] }> },
) {
  const { projectId, path: pathSegments } = await params;

  const workspacePreview = await readWorkspacePreview(projectId, pathSegments);
  if (workspacePreview) {
    return new Response(workspacePreview.content, {
      headers: { "Content-Type": workspacePreview.contentType },
    });
  }

  const project = getWebsiteProject(projectId);

  if (!project) {
    return new Response(notFoundHtml(false), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const targetPath = "/" + pathSegments.join("/");
  const page = project.pages.find((p) => p.path === targetPath);

  if (!page) {
    return new Response(notFoundHtml(true), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const resolveHref = (path: string) =>
    path === "/"
      ? `/preview/${projectId}`
      : `/preview/${projectId}${path}`;

  const html = renderPageDocument(project, targetPath, {
    resolveHref,
    inlineCss: true,
  });

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}