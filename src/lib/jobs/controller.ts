export class JobStoppedError extends Error {
  constructor() {
    super("Job stopped.");
    this.name = "JobStoppedError";
  }
}

export class JobController {
  jobId: string;
  private paused = false;
  private stopRequested = false;
  private resumeWaiters: Array<() => void> = [];

  constructor(jobId: string) {
    this.jobId = jobId;
  }

  requestStop(): void {
    this.stopRequested = true;
    this.resume();
  }

  requestPause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const resolve of waiters) resolve();
  }

  get isStopRequested(): boolean {
    return this.stopRequested;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Call before each discrete unit of work. Blocks while paused and throws
   * JobStoppedError if a stop was requested, so in-flight units are allowed to
   * finish while no new units are started.
   */
  async checkpoint(): Promise<void> {
    while (this.paused) {
      await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
    }
    if (this.stopRequested) throw new JobStoppedError();
  }

  assertNotStopped(): void {
    if (this.stopRequested) throw new JobStoppedError();
  }
}