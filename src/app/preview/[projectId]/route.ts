import { getWebsiteProject } from "@/lib/website-store";
import { renderPageDocument } from "@/lib/website-render";
import { readWorkspacePreview } from "@/lib/website-preview";

export const dynamic = "force-dynamic";

function notFoundHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Preview unavailable</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; color: #334155; background: #f8fafc; text-align: center; padding: 2rem; }
    p { color: #64748b; max-width: 400px; margin: 0.75rem auto 0; line-height: 1.6; }
  </style>
</head>
<body>
  <div>
    <h1>Preview unavailable</h1>
    <p>This preview could not be found. Re-generate it from the campaign page.</p>
  </div>
</body>
</html>`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const workspacePreview = await readWorkspacePreview(projectId, []);
  if (workspacePreview) {
    return new Response(workspacePreview.content, {
      headers: { "Content-Type": workspacePreview.contentType },
    });
  }

  const project = getWebsiteProject(projectId);

  if (!project) {
    return new Response(notFoundHtml(), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const resolveHref = (path: string) =>
    path === "/"
      ? `/preview/${projectId}`
      : `/preview/${projectId}${path}`;

  const html = renderPageDocument(project, "/", {
    resolveHref,
    inlineCss: true,
  });

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}