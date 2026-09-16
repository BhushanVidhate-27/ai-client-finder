import { NextResponse } from "next/server";
import { ensureJobStateFresh, listJobs } from "@/lib/data/jobs";
import { listActivity } from "@/lib/data/activity";
import { seedDefaultAgents, getAgent } from "@/lib/agents/registry";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

seedDefaultAgents();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const { id } = await params;
  ensureJobStateFresh();

  const def = getAgent(id);
  if (!def) {
    return NextResponse.json(
      { error: "Agent not found." },
      { status: 404 },
    );
  }

  // Return jobs whose type or agentId matches this agent definition.
  const allJobs = listJobs(200);
  const jobs = allJobs.filter(
    (job) =>
      job.type === def.jobType ||
      (job.metadata.agentId as string | undefined) === def.id,
  );

  // Optional: if ?jobId= is present, return its activity for the detail view.
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  let activity: Awaited<ReturnType<typeof listActivity>> = [];
  if (jobId) {
    activity = listActivity({ jobId, limit: 50 });
  }

  return NextResponse.json({ agent: def, jobs, activity });
}