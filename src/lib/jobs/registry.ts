import type { JobController } from "@/lib/jobs/controller";

const controllers = new Map<string, JobController>();

export function registerJobController(controller: JobController): void {
  controllers.set(controller.jobId, controller);
}

export function getJobController(jobId: string): JobController | null {
  return controllers.get(jobId) ?? null;
}

export function clearJobController(jobId: string): void {
  controllers.delete(jobId);
}

export function activeControllerIds(): string[] {
  return [...controllers.keys()];
}