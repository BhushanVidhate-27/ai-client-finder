import { NextResponse } from "next/server";
import { getLeadById } from "@/lib/data/leads";
import { getWebsiteProjectRecordByLeadId } from "@/lib/data/websites";
import { listDeploymentRecordsByProject } from "@/lib/data/deployments";
import { runJob } from "@/lib/jobs/run-job";
import { runWebsiteDeployment } from "@/lib/jobs/website-deployment-flow";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";
import type { DeploymentProviderId } from "@/lib/deployment/types";

const VALID_PROVIDERS: DeploymentProviderId[] = [
  "vercel",
  "netlify",
  "cloudflare",
  "mock",
];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ leadId: string }> },
) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const { leadId } = await params;
  const stored = getLeadById(leadId);
  if (!stored) {
    return NextResponse.json({ error: "Lead not found." }, { status: 404 });
  }

  let body: { provider?: string; versionId?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const provider = body.provider as DeploymentProviderId | undefined;
  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json(
      { error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const outcome = await runJob(
      { type: "deployment", leadId },
      async (controller) => {
        return runWebsiteDeployment(
          { leadId, provider, versionId: body.versionId, controller },
        );
      },
    );

    return NextResponse.json({ deployment: outcome.result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deployment failed.";
    // JobStopped is thrown by runJob on stop — return 200 so the UI knows
    // it was intentionally stopped, not an error.
    if (message === "Job stopped.") {
      return NextResponse.json({ status: "stopped" });
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leadId: string }> },
) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const { leadId } = await params;
  const project = getWebsiteProjectRecordByLeadId(leadId);
  if (!project) {
    return NextResponse.json({ deployments: [] });
  }

  const deployments = listDeploymentRecordsByProject(project.projectId);
  return NextResponse.json({ deployments });
}
