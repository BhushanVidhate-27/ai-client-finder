import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/data/db";
import { resetDatabase } from "@/lib/data/schema";
import {
  createJob,
  ensureJobStateFresh,
  getJob,
  interruptStaleJobs,
  tryTransitionJobStatus,
  updateJob,
} from "@/lib/data/jobs";

beforeEach(() => {
  resetDatabase(getDb());
});

describe("retry eligibility and concurrency protection", () => {
  it("only claims jobs in failed/stopped/interrupted, not completed or running", () => {
    const job = createJob({ type: "research", campaignId: null, leadId: null, metadata: {} });

    // completed: not retryable
    expect(tryTransitionJobStatus(job.id, ["queued"], "completed")).toBe(true);
    expect(
      tryTransitionJobStatus(job.id, ["failed", "stopped", "interrupted"], "running"),
    ).toBe(false);
    expect(getJob(job.id)?.status).toBe("completed");
  });

  it("atomically claims a failed job exactly once (one retry only)", () => {
    const job = createJob({ type: "research", campaignId: null, leadId: null, metadata: {} });
    expect(tryTransitionJobStatus(job.id, ["queued"], "failed")).toBe(true);

    const firstClaim = tryTransitionJobStatus(
      job.id,
      ["failed", "stopped", "interrupted"],
      "running",
    );
    expect(firstClaim).toBe(true);

    // A concurrent retry sees the job already running and cannot claim it.
    const secondClaim = tryTransitionJobStatus(
      job.id,
      ["failed", "stopped", "interrupted"],
      "running",
    );
    expect(secondClaim).toBe(false);
    expect(getJob(job.id)?.status).toBe("running");
  });

  it("allows retry of stopped and interrupted jobs", () => {
    const stopped = createJob({ type: "website_generation", campaignId: null, leadId: "l", metadata: {} });
    expect(tryTransitionJobStatus(stopped.id, ["queued"], "stopped", { stoppedAt: new Date().toISOString() })).toBe(true);
    expect(tryTransitionJobStatus(stopped.id, ["failed", "stopped", "interrupted"], "running")).toBe(true);

    const interrupted = createJob({ type: "website_generation", campaignId: null, leadId: "l", metadata: {} });
    expect(tryTransitionJobStatus(interrupted.id, ["queued"], "interrupted")).toBe(true);
    expect(tryTransitionJobStatus(interrupted.id, ["failed", "stopped", "interrupted"], "running")).toBe(true);
  });

  it("rejects retry attempts for running jobs (no double execution)", () => {
    const job = createJob({ type: "research", campaignId: null, leadId: null, metadata: {} });
    expect(tryTransitionJobStatus(job.id, ["queued"], "running")).toBe(true);
    expect(tryTransitionJobStatus(job.id, ["failed", "stopped", "interrupted"], "running")).toBe(false);
  });
});

describe("durable job recovery on startup", () => {
  it("marks running jobs left by a previous process as interrupted", () => {
    const job = createJob({ type: "research", campaignId: null, leadId: null, metadata: {} });
    expect(tryTransitionJobStatus(job.id, ["queued"], "running", { currentStep: "mid-flight" })).toBe(true);

    expect(interruptStaleJobs()).toBe(1);

    const recovered = getJob(job.id);
    expect(recovered?.status).toBe("interrupted");
    expect(recovered?.currentStep).toBe("interrupted");
    expect(recovered?.error).toContain("restarted");
    expect(recovered?.stoppedAt).toBeTruthy();
  });

  it("also recovers jobs left in the stopping state", () => {
    const job = createJob({ type: "website_generation", campaignId: null, leadId: "l", metadata: {} });
    expect(tryTransitionJobStatus(job.id, ["queued"], "stopping")).toBe(true);
    expect(interruptStaleJobs()).toBe(1);
    expect(getJob(job.id)?.status).toBe("interrupted");
  });

  it("does not touch terminal states (completed/failed/stopped)", () => {
    const completed = createJob({ type: "research", campaignId: null, leadId: null, metadata: {} });
    tryTransitionJobStatus(completed.id, ["queued"], "completed");
    const failed = createJob({ type: "research", campaignId: null, leadId: null, metadata: {} });
    tryTransitionJobStatus(failed.id, ["queued"], "failed");
    const stopped = createJob({ type: "research", campaignId: null, leadId: null, metadata: {} });
    tryTransitionJobStatus(stopped.id, ["queued"], "stopped");

    expect(interruptStaleJobs()).toBe(0);
    expect(getJob(completed.id)?.status).toBe("completed");
    expect(getJob(failed.id)?.status).toBe("failed");
    expect(getJob(stopped.id)?.status).toBe("stopped");
  });

  it("ensureJobStateFresh is idempotent per process", () => {
    const job = createJob({ type: "research", campaignId: null, leadId: null, metadata: {} });
    updateJob(job.id, { status: "running", currentStep: "stale" });

    // First invocation recovers; the module-level check makes later calls no-ops.
    expect(ensureJobStateFresh()).toBe(1);
    expect(ensureJobStateFresh()).toBe(0);
    expect(getJob(job.id)?.status).toBe("interrupted");
  });
});