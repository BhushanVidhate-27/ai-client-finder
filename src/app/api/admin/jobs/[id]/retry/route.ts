import { NextResponse } from "next/server";
import {
  ensureJobStateFresh,
  getJob,
  tryTransitionJobStatus,
} from "@/lib/data/jobs";
import { retryJob } from "@/lib/jobs/retry-worker";
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

  const RETRYABLE = ["failed", "stopped", "interrupted"] as const;
  if (!(RETRYABLE as readonly string[]).includes(job.status)) {
    return NextResponse.json(
      {
        error:
          "Only failed, stopped, or interrupted jobs can be retried. Current status: " +
          job.status,
        status: job.status,
      },
      { status: 409 },
    );
  }

  const claimed = tryTransitionJobStatus(
    id,
    RETRYABLE,
    "running",
    {
      startedAt: new Date().toISOString(),
      currentStep: "retrying",
    },
  );
  if (!claimed) {
    const fresh = getJob(id);
    return NextResponse.json(
      {
        error: "Job is already being retried.",
        status: fresh?.status ?? "unknown",
      },
      { status: 409 },
    );
  }

  void retryJob(id);

  return NextResponse.json({ ok: true, status: "running" });
}