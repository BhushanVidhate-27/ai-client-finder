import { NextResponse } from "next/server";
import {
  ensureJobStateFresh,
  getJob,
  tryTransitionJobStatus,
} from "@/lib/data/jobs";
import { getJobController } from "@/lib/jobs/registry";
import { logActivity } from "@/lib/data/activity";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const { id } = await params;
  ensureJobStateFresh();

  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  if (job.status !== "running") {
    return NextResponse.json(
      { error: "Only running jobs can be paused.", status: job.status },
      { status: 409 },
    );
  }

  const controller = getJobController(id);
  if (!controller) {
    return NextResponse.json(
      { error: "Job is not running in this process." },
      { status: 409 },
    );
  }

  controller.requestPause();
  const paused = tryTransitionJobStatus(id, ["running"], "paused");
  if (!paused) {
    return NextResponse.json(
      { error: "Job changed state before it could be paused.", status: getJob(id)?.status },
      { status: 409 },
    );
  }
  logActivity({ action: "job.paused", jobId: id });

  return NextResponse.json({ ok: true, status: getJob(id)?.status });
}