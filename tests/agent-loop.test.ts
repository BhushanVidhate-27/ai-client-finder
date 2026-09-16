import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/data/db";
import { resetDatabase } from "@/lib/data/schema";
import { getJob, updateJobMetadata } from "@/lib/data/jobs";
import { listActivity } from "@/lib/data/activity";
import { JobController } from "@/lib/jobs/controller";
import { runAgentLoop, MAX_ITERATIONS_REASON, TIMEOUT_REASON } from "@/lib/agents/loop-engine";
import { getAgent, listAgents, seedDefaultAgents } from "@/lib/agents/registry";
import { AgentToolbox, ToolNotFoundError, ToolNotImplementedError } from "@/lib/agents/toolbox";
import { PermissionError } from "@/lib/agents/permissions";
import { sanityAgent } from "@/lib/agents/sanity-agent";
import { runAgentWorkflow, AgentExecutionError } from "@/lib/agents/run-agent-workflow";
import type {
  Agent,
  AgentAction,
  AgentContext,
  AgentLoopState,
  AgentObservation,
  AgentVerification,
  AgentStep,
} from "@/lib/agents/types";
import type { AgentPermission } from "@/lib/agents/permissions";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function stubContext(goal = "Test goal"): AgentContext {
  return {
    goal: { description: goal, acceptanceCriteria: ["pass test"] },
    constraints: [],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeAgentOptions {
  /** Iteration number at which verification first passes (1-indexed). */
  passAt?: number;
  /** If true, verification never passes. */
  alwaysFail?: boolean;
  /** Steps to use (defaults to a 3-step plan). */
  steps?: AgentStep[];
  /** Tool name for decide to return (defaults to "noop"). */
  actionName?: string;
  /** Permission on the decide action (defaults to "read"). */
  actionPermission?: AgentPermission;
  /** If true, inspect throws on the given iteration. */
  inspectError?: number;
  /** If true, verify throws on the given iteration. */
  verifyError?: number;
}

function makeFakeAgent(options: FakeAgentOptions = {}): Agent {
  const {
    passAt = 999,
    alwaysFail = false,
    steps = [
      { id: "s1", label: "Step 1" },
      { id: "s2", label: "Step 2" },
      { id: "s3", label: "Step 3" },
    ],
    actionName = "noop",
    actionPermission = "read",
    inspectError,
    verifyError,
  } = options;

  const noopTool = {
    name: "noop",
    description: "No-op",
    permission: "read" as AgentPermission,
    execute: () => ({ ok: true }),
  };

  const writeTool = {
    name: "write-op",
    description: "Write op",
    permission: "write" as AgentPermission,
    execute: () => ({ ok: true }),
  };

  return {
    id: "fake",
    name: "Fake Agent",
    description: "Test",
    jobType: "agent_test",
    permissions: ["read"],
    tools: [noopTool, writeTool],
    planner: {
      plan: () => ({
        objective: "Test goal",
        constraints: [],
        acceptanceCriteria: ["Complete"],
        steps,
        allowedActions: ["noop", "write-op"],
        verificationRequirements: ["Complete"],
        maxIterations: 10,
      }),
    },
    plan: (ctx: AgentContext) => ({
      objective: ctx.goal.description,
      constraints: [],
      acceptanceCriteria: ["Complete"],
      steps,
      allowedActions: ["noop", "write-op"],
      verificationRequirements: ["Complete"],
      maxIterations: 10,
    }),

    inspect: (
      _ctx: AgentContext,
      state: AgentLoopState,
    ): AgentObservation => {
      if (inspectError && state.iteration === inspectError) {
        throw new Error("inspect failed");
      }
      return {
        id: `obs-${state.iteration}`,
        iteration: state.iteration,
        description: `iter ${state.iteration}`,
        at: nowIso(),
      };
    },

    decide: (
      _ctx: AgentContext,
      state: AgentLoopState,
    ): AgentAction => {
      const idx = steps.findIndex((s) => s.id === state.currentStepId);
      const next = steps[idx + 1] ?? null;
      return {
        name: actionName,
        permission: actionPermission,
        description: `action iter ${state.iteration}`,
        completesStep: true,
        nextStepId: next?.id ?? null,
      };
    },

    verify: (
      _ctx: AgentContext,
      state: AgentLoopState,
    ): AgentVerification => {
      if (verifyError && state.iteration === verifyError) {
        throw new Error("verify failed");
      }
      const allDone = state.completedSteps.length === steps.length;
      const passed = alwaysFail ? false : allDone || state.iteration >= passAt;
      return {
        id: `ver-${state.iteration}`,
        iteration: state.iteration,
        passed,
        checks: [{ requirement: "done", passed }],
        at: nowIso(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loop-engine", () => {
  it("successful multi-iteration loop completes when all steps done", async () => {
    const agent = makeFakeAgent();
    const controller = new JobController("job-1");
    const result = await runAgentLoop({
      agent,
      context: stubContext(),
      controller,
    });

    expect(result.status).toBe("completed");
    expect(result.iteration).toBe(3);
    expect(result.completedSteps).toEqual(["s1", "s2", "s3"]);
    expect(result.error).toBeNull();
    expect(result.history.observations.length).toBeGreaterThanOrEqual(3);
    expect(result.history.actions.length).toBeGreaterThanOrEqual(3);
    expect(result.history.verificationResults.length).toBeGreaterThanOrEqual(3);
  });

  it("verification failure causes another iteration", async () => {
    // Fails verification on iteration 1, passes on 2
    const agent = makeFakeAgent({ passAt: 2 });
    const controller = new JobController("job-vf");
    const result = await runAgentLoop({
      agent,
      context: stubContext(),
      controller,
    });

    expect(result.status).toBe("completed");
    expect(result.iteration).toBeGreaterThanOrEqual(2);
    const verifications = result.history.verificationResults;
    expect(verifications.length).toBeGreaterThanOrEqual(2);
    expect(verifications[0].passed).toBe(false);
    expect(verifications[verifications.length - 1].passed).toBe(true);
  });

  it("successful verification ends loop early (no extra iterations)", async () => {
    // Passes on iteration 1
    const agent = makeFakeAgent({ passAt: 1 });
    const controller = new JobController("job-ve");
    const result = await runAgentLoop({
      agent,
      context: stubContext(),
      controller,
    });

    expect(result.status).toBe("completed");
    expect(result.iteration).toBe(1);
    expect(result.history.verificationResults).toHaveLength(1);
    expect(result.history.verificationResults[0].passed).toBe(true);
  });

  it("max iteration termination", async () => {
    const agent = makeFakeAgent({ alwaysFail: true });
    const controller = new JobController("job-max");
    const result = await runAgentLoop({
      agent,
      context: stubContext(),
      config: { maxIterations: 3 },
      controller,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe(MAX_ITERATIONS_REASON);
    expect(result.iteration).toBe(3);
    expect(result.history.verificationResults.length).toBeGreaterThanOrEqual(3);
    expect(result.history.verificationResults.every((v) => v.passed)).toBe(
      false,
    );
  });

  it("timeout termination", async () => {
    const agent = makeFakeAgent();
    // Override inspect to be slow.
    const originalInspect = agent.inspect;
    agent.inspect = async (ctx, state) => {
      await sleep(50);
      return originalInspect(ctx, state);
    };

    const controller = new JobController("job-timeout");
    const result = await runAgentLoop({
      agent,
      context: stubContext(),
      config: { maxIterations: 10, timeoutMs: 15 },
      controller,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe(TIMEOUT_REASON);
    expect(result.iteration).toBeLessThanOrEqual(2);
  });

  it("stop during iteration preserves history and marks stopped", async () => {
    const agent = makeFakeAgent({ passAt: 999 });
    const controller = new JobController("job-stop");

    // Request stop on the first milestone event so iteration 2 never starts.
    let stopped = false;
    const result = await runAgentLoop({
      agent,
      context: stubContext(),
      controller,
      onMilestone: (milestone) => {
        if (milestone === "iteration_completed" && !stopped) {
          stopped = true;
          controller.requestStop();
        }
      },
    });

    expect(result.status).toBe("stopped");
    expect(result.error).toContain("stopped");
    expect(result.history.iteration).toBeGreaterThanOrEqual(1);
    // History is preserved.
    expect(result.history.actions.length).toBeGreaterThanOrEqual(1);
  });

  it("stop before first iteration prevents any work", async () => {
    const agent = makeFakeAgent();
    const controller = new JobController("job-stop-before");
    controller.requestStop();

    const result = await runAgentLoop({
      agent,
      context: stubContext(),
      controller,
    });

    expect(result.status).toBe("stopped");
    expect(result.history.iteration).toBe(0);
    expect(result.history.actions).toHaveLength(0);
    expect(result.history.observations).toHaveLength(0);
  });

  it("pause/resume compatibility", async () => {
    const agent = makeFakeAgent({ passAt: 999 });
    const controller = new JobController("job-pause");
    controller.requestPause();

    let settled = false;
    const promise = runAgentLoop({
      agent,
      context: stubContext(),
      config: { maxIterations: 3 },
      controller,
    }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // While paused the loop should not advance.
    await sleep(30);
    expect(settled).toBe(false);

    // Resume.
    controller.resume();
    await promise;

    // Should have completed all 3 iterations.
    expect(settled).toBe(true);
  });

  it("structured iteration history has expected shape", async () => {
    const agent = makeFakeAgent({ passAt: 3 });
    const controller = new JobController("job-history");
    const result = await runAgentLoop({
      agent,
      context: stubContext(),
      controller,
    });

    expect(result.status).toBe("completed");
    const h = result.history;
    expect(h.iteration).toBe(3);
    expect(h.maxIterations).toBe(10);
    expect(h.goal).toBe("Test goal");
    expect(h.steps).toHaveLength(3);
    expect(h.completedSteps).toEqual(["s1", "s2", "s3"]);
    expect(h.progress).toBe(100);

    // Each iteration produced an observation, action, and verification.
    expect(h.observations.length).toBeGreaterThanOrEqual(3);
    expect(h.actions.length).toBeGreaterThanOrEqual(3);
    expect(h.verificationResults.length).toBeGreaterThanOrEqual(3);
    expect(h.errors).toHaveLength(0);

    // Each action record has the expected fields.
    for (const action of h.actions) {
      expect(action.id).toBeTruthy();
      expect(action.name).toBe("noop");
      expect(action.permission).toBe("read");
      expect(["succeeded", "failed", "rejected"]).toContain(action.status);
      expect(action.at).toBeTruthy();
    }
  });

  it("permission rejection is recorded and tool is not called", async () => {
    let toolCalled = false;
    const agent = makeFakeAgent({
      actionName: "write-op",
      actionPermission: "write",
      passAt: 1,
    });
    // Replace write-op tool to track calls.
    const origTool = agent.tools!.find((t) => t.name === "write-op")!;
    origTool.execute = () => {
      toolCalled = true;
      return { ok: true };
    };
    // Grant only read — write should be rejected.
    const controller = new JobController("job-perm");
    const result = await runAgentLoop({
      agent,
      context: stubContext(),
      config: { toolPermissions: ["read"] },
      controller,
    });

    expect(result.status).toBe("completed");
    expect(toolCalled).toBe(false);
    // The action should be recorded as rejected.
    const rejectedActions = result.history.actions.filter(
      (a) => a.status === "rejected",
    );
    expect(rejectedActions.length).toBeGreaterThanOrEqual(1);
    expect(rejectedActions[0].error).toContain("write");
  });

  it("inspect/decide errors are recorded and loop continues", async () => {
    const agent = makeFakeAgent({ inspectError: 1, passAt: 2 });
    const controller = new JobController("job-inspect-err");
    const result = await runAgentLoop({
      agent,
      context: stubContext(),
      config: { maxIterations: 5 },
      controller,
    });

    // Iteration 1 fails (inspect error), iteration 2 passes (all steps done).
    expect(result.status).toBe("completed");
    expect(result.iteration).toBeGreaterThanOrEqual(2);
    expect(result.history.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.history.errors[0].message).toContain("inspect failed");
  });

  it("verify error on one iteration does not crash the loop", async () => {
    const agent = makeFakeAgent({ verifyError: 1, passAt: 2 });
    const controller = new JobController("job-verify-err");
    const result = await runAgentLoop({
      agent,
      context: stubContext(),
      config: { maxIterations: 5 },
      controller,
    });

    expect(result.status).toBe("completed");
    expect(result.iteration).toBeGreaterThanOrEqual(2);
    // The failed verification on iter 1 should be recorded as not-passed.
    const v1 = result.history.verificationResults[0];
    expect(v1.passed).toBe(false);
  });

  it("no infinite loop: always-fail agent stops at maxIterations", async () => {
    const agent = makeFakeAgent({ alwaysFail: true });
    const controller = new JobController("job-infinite");
    const start = Date.now();
    const result = await runAgentLoop({
      agent,
      context: stubContext(),
      config: { maxIterations: 5 },
      controller,
    });
    const elapsed = Date.now() - start;

    expect(result.status).toBe("failed");
    expect(result.iteration).toBe(5);
    // Must complete quickly (< 2s) — no actual work being done.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("AgentToolbox", () => {
  it("allows permitted action and calls executor", async () => {
    let called = false;
    const toolbox = new AgentToolbox(
      [
        {
          name: "noop",
          description: "test",
          permission: "read",
          execute: () => {
            called = true;
            return { result: 1 };
          },
        },
      ],
      ["read"],
    );

    const result = await toolbox.run(
      { name: "noop", permission: "read" },
      stubContext(),
    );
    expect(called).toBe(true);
    expect(result).toEqual({ result: 1 });
  });

  it("rejects action with missing permission", async () => {
    const toolbox = new AgentToolbox([], ["read"]);

    await expect(
      toolbox.run({ name: "noop", permission: "write" }, stubContext()),
    ).rejects.toThrow(PermissionError);
  });

  it("throws ToolNotFoundError for unknown tool", async () => {
    const toolbox = new AgentToolbox([], ["read"]);

    await expect(
      toolbox.run({ name: "missing", permission: "read" }, stubContext()),
    ).rejects.toThrow(ToolNotFoundError);
  });

  it("throws ToolNotImplementedError when tool has no executor", async () => {
    const toolbox = new AgentToolbox(
      [{ name: "stub", description: "no exec", permission: "read" }],
      ["read"],
    );

    await expect(
      toolbox.run({ name: "stub", permission: "read" }, stubContext()),
    ).rejects.toThrow(ToolNotImplementedError);
  });

  it("hasPermission reflects granted set", () => {
    const toolbox = new AgentToolbox([], ["read", "write"]);
    expect(toolbox.hasPermission("read")).toBe(true);
    expect(toolbox.hasPermission("write")).toBe(true);
    expect(toolbox.hasPermission("deploy")).toBe(false);
  });
});

describe("agent registry", () => {
  beforeEach(() => {
    seedDefaultAgents();
  });

  it("registers and retrieves agents by id", () => {
    const def = getAgent("loop-sanity");
    expect(def).toBeDefined();
    expect(def!.name).toBe("Loop Sanity Agent");
    expect(def!.status).toBe("available");
  });

  it("lists all registered agents", () => {
    const all = listAgents();
    expect(all.length).toBeGreaterThanOrEqual(6);
    const ids = all.map((a) => a.id);
    expect(ids).toContain("loop-sanity");
    expect(ids).toContain("research");
    expect(ids).toContain("website-builder");
    expect(ids).toContain("qualification");
    expect(ids).toContain("qa");
    expect(ids).toContain("deployment");
    expect(ids).toContain("outreach");
  });

  it("planned agents have no runner", () => {
    const def = getAgent("research");
    expect(def).toBeDefined();
    expect(def!.status).toBe("planned");
    expect(def!.runner).toBeUndefined();
  });

  it("runnable agent has runner and status available", () => {
    const def = getAgent("loop-sanity");
    expect(def).toBeDefined();
    expect(def!.runner).toBeDefined();
    expect(def!.status).toBe("available");
  });
});

describe("sanity agent (full loop)", () => {
  it("completes successfully in exactly steps.length iterations", async () => {
    const controller = new JobController("job-sanity");
    const result = await runAgentLoop({
      agent: sanityAgent,
      context: stubContext("Exercise the loop framework"),
      controller,
    });

    expect(result.status).toBe("completed");
    expect(result.iteration).toBe(4); // 4 LOGICAL_STEPS
    expect(result.completedSteps).toEqual([
      "prepare",
      "generate",
      "verify-build",
      "finish",
    ]);
    expect(result.progress).toBe(100);
    expect(result.error).toBeNull();
    expect(result.history.actions.length).toBeGreaterThanOrEqual(4);
    expect(
      result.history.verificationResults.at(-1)!.passed,
    ).toBe(true);
  });
});

describe("runAgentWorkflow (job integration)", () => {
  beforeEach(() => {
    resetDatabase(getDb());
    seedDefaultAgents();
  });

  it("creates a job row, runs the loop, and persists activity", async () => {
    const { jobId, result } = await runAgentWorkflow({
      agentId: "loop-sanity",
      goal: "Test integration",
    });

    expect(result.status).toBe("completed");
    expect(jobId).toBeTruthy();

    const job = getJob(jobId);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("completed");
    expect(job!.type).toBe("agent_loop_sanity");

    // Metadata should contain agent summary.
    const agentMeta = job!.metadata.agent as
      | Record<string, unknown>
      | undefined;
    expect(agentMeta).toBeDefined();
    expect(agentMeta!.id).toBe("loop-sanity");
    expect(agentMeta!.iteration).toBe(4);
    expect(agentMeta!.maxIterations).toBe(6);

    // Activity log should have agent milestones.
    const activity = listActivity({ jobId, limit: 100 });
    expect(activity.length).toBeGreaterThanOrEqual(4);
    const milestoneActions = activity.map((a) => a.action);
    expect(milestoneActions).toContain("agent.completed");
    expect(milestoneActions.some((a) => a.startsWith("agent."))).toBe(true);
  });

  it("throws AgentExecutionError for unregistered agent", async () => {
    await expect(
      runAgentWorkflow({ agentId: "nonexistent", goal: "nope" }),
    ).rejects.toThrow(AgentExecutionError);
  });

  it("throws AgentExecutionError for planned (non-runnable) agent", async () => {
    await expect(
      runAgentWorkflow({ agentId: "research", goal: "nope" }),
    ).rejects.toThrow(AgentExecutionError);
  });
});

describe("updateJobMetadata", () => {
  beforeEach(() => {
    resetDatabase(getDb());
    seedDefaultAgents();
  });

  it("merges metadata without clobbering existing keys", async () => {
    const { jobId } = await runAgentWorkflow({
      agentId: "loop-sanity",
      goal: "Metadata test",
    });

    // Existing metadata.agent should be present from runAgentWorkflow.
    let job = getJob(jobId);
    expect(job).not.toBeNull();
    expect(job!.metadata.agent).toBeDefined();

    // Add a new key via updateJobMetadata.
    updateJobMetadata(jobId, { extra: "hello" });
    job = getJob(jobId);
    expect(job!.metadata.extra).toBe("hello");
    // Original agent metadata is preserved.
    expect(job!.metadata.agent).toBeDefined();
  });
});

describe("loop-engine onMilestone reporting", () => {
  it("fires milestones in expected order", async () => {
    const agent = makeFakeAgent({ passAt: 1 });
    const controller = new JobController("job-milestones");
    const milestones: string[] = [];

    await runAgentLoop({
      agent,
      context: stubContext(),
      controller,
      onMilestone: (milestone) => {
        milestones.push(milestone);
      },
    });

    expect(milestones).toContain("iteration_started");
    expect(milestones).toContain("inspection");
    expect(milestones).toContain("action_started");
    expect(milestones).toContain("action_succeeded");
    expect(milestones).toContain("verification");
    expect(milestones).toContain("completed");
    expect(milestones.indexOf("iteration_started")).toBeLessThan(
      milestones.indexOf("completed"),
    );
  });

  it("fires failed milestone on max iterations", async () => {
    const agent = makeFakeAgent({ alwaysFail: true });
    const controller = new JobController("job-mile-fail");
    const milestones: string[] = [];

    await runAgentLoop({
      agent,
      context: stubContext(),
      config: { maxIterations: 2 },
      controller,
      onMilestone: (milestone) => {
        milestones.push(milestone);
      },
    });

    expect(milestones).toContain("failed");
    expect(milestones[milestones.length - 1]).toBe("failed");
  });
});
