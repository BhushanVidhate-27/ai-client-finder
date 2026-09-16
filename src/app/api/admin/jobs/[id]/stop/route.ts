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

  const controller = getJobController(id);
  if (controller) {
    controller.requestStop();
    tryTransitionJobStatus(
      id,
      ["running", "paused"],
      "stopping",
    );
  } else {
    // No in-process controller: the job is queued but not yet claimed, or was
    // already interrupted by recovery. Mark it stopped directly.
    tryTransitionJobStatus(
      id,
      ["queued", "running", "paused", "stopping"],
      "stopped",
      { stoppedAt: new Date().toISOString(), currentStep: "stopped" },
    );
  }

  logActivity({ action: "job.stop_requested", jobId: id });

  return NextResponse.json({ ok: true, status: getJob(id)?.status });
}