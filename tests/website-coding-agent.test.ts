import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDatabase } from "@/lib/data/schema";
import { getDb } from "@/lib/data/db";
import { JobController } from "@/lib/jobs/controller";
import {
  runAgentLoop,
  MAX_ITERATIONS_REASON,
} from "@/lib/agents/loop-engine";
import { AgentToolbox, ToolNotFoundError } from "@/lib/agents/toolbox";
import { PermissionError } from "@/lib/agents/permissions";
import {
  getAgent,
  isAgentRunnable,
  listAgents,
  seedDefaultAgents,
} from "@/lib/agents/registry";
import { createWebsiteCodingAgent } from "@/lib/website-coding/agent";
import { renderSiteSource } from "@/lib/website-coding/site-render";
import { buildWorkspace } from "@/lib/website-coding/build";
import {
  assertSafeProjectId,
  listWorkspaceFiles,
  WorkspacePathError,
  WorkspaceProjectIdError,
  workspaceDir,
  writeBuildManifest,
} from "@/lib/website-coding/workspace";
import type { AgentContext } from "@/lib/agents/types";
import type { BuildFailure } from "@/lib/website-coding/build";
import { makeLead, makeResearch } from "./helpers";
import type { ContactDiscovery } from "@/lib/contact-discovery";

function testContact(
  overrides: Partial<ContactDiscovery> = {},
): ContactDiscovery {
  return {
    email: "office@acme.test",
    emailType: "business",
    emailSourceUrl: null,
    emailConfidence: "high",
    emailStatus: "found",
    phone: "+1 555 0100",
    phoneSourceUrl: null,
    contactMethod: "email",
    discoveryPath: "no_website",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let tmpRoot: string;
let controller: JobController;

function codingContext(overrides: Record<string, unknown> = {}): AgentContext {
  return {
    goal: { description: "Create a website", acceptanceCriteria: [] },
    constraints: [],
    references: {
      lead: makeLead("p1", "Acme Plumbing"),
      research: makeResearch(),
      contact: testContact(),
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Website Coding Agent", () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "acf-website-agent-"));
    process.env.WORKSPACES_ROOT = tmpRoot;
    resetDatabase(getDb());
    controller = new JobController("job-website-coder");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.WORKSPACES_ROOT;
  });

  it("1. registers website-coder as a runnable agent with read/write/execute only", () => {
    seedDefaultAgents();
    const def = getAgent("website-coder");
    expect(def).toBeDefined();
    expect(def?.status).toBe("available");
    expect(isAgentRunnable("website-coder")).toBe(true);
    expect([...new Set(def?.permissions ?? [])]).toEqual([
      "read",
      "write",
      "execute",
    ]);
    expect(listAgents().map((a) => a.id)).toContain("website-coder");
  });

  it("2. happy path: generates a verified static website for a qualified prospect", async () => {
    const agent = createWebsiteCodingAgent();
    const result = await runAgentLoop({
      agent,
      context: codingContext({ projectId: "acme-plumbing" }),
      controller,
    });

    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.iteration).toBeLessThanOrEqual(8);

    const artifact = result.result as { status: string; projectId: string };
    expect(artifact.status).toBe("success");
    expect(artifact.projectId).toBe("acme-plumbing");

    const files = await listWorkspaceFiles("acme-plumbing");
    const names = files.map((f) => f.path).sort();
    expect(names).toContain("index.html");
    expect(names).toContain("styles.css");
    expect(names).toContain("script.js");
    expect(names).toContain("package.json");

    const buildManifest = readFileSync(
      path.join(workspaceDir("acme-plumbing"), "build.json"),
      "utf8",
    );
    expect(JSON.parse(buildManifest).status).toBe("success");

    const verification = result.history.verificationResults.at(-1);
    expect(verification?.passed).toBe(true);
    expect(verification?.checks.length).toBeGreaterThanOrEqual(6);
  });

  it("3. writes only inside the isolated workspace directory", async () => {
    const agent = createWebsiteCodingAgent();
    const result = await runAgentLoop({
      agent,
      context: codingContext({ projectId: "acme-plumbing" }),
      controller,
    });
    expect(result.status).toBe("completed");

    const paths = (await listWorkspaceFiles("acme-plumbing")).map((f) => f.path);
    expect(paths.length).toBeGreaterThan(0);
    // Every path lives either directly in the project dir or loop the nested
    // page files — never outside it, never at the repo root.
    for (const p of paths) {
      expect(p.startsWith("..")).toBe(false);
      expect(p.startsWith("/")).toBe(false);
    }
    // Nothing outside the workspace root was created by the agent.
    const repoCheck = path.join(tmpRoot, "..", "repo-root-check");
    expect(existsSync(repoCheck)).toBe(false);
  });

  it("4. build failure is observed, fixed, and rebuilt to success", async () => {
    let failFirst = true;
    const failOnceBuild = async (projectId: string, requiredFiles?: string[]) => {
      if (failFirst) {
        failFirst = false;
        const failure: BuildFailure = {
          status: "error",
          projectId,
          workspace: workspaceDir(projectId),
          errors: [
            {
              file: "index.html",
              code: "malformed-html",
              message: "Simulated build failure for test.",
            },
          ],
          builtAt: new Date().toISOString(),
        };
        await writeBuildManifest(projectId, failure);
        return failure;
      }
      return buildWorkspace(projectId, requiredFiles);
    };

    const agent = createWebsiteCodingAgent({ build: failOnceBuild });
    const result = await runAgentLoop({
      agent,
      context: codingContext({ projectId: "acme-plumbing" }),
      controller,
    });

    expect(result.status).toBe("completed");

    const buildAttempts = result.history.actions.filter(
      (a) => a.name === "website.build",
    );
    expect(buildAttempts.length).toBeGreaterThanOrEqual(2);
    // First build should have reported an error in its data payload.
    const firstBuildResult = buildAttempts[0];
    const firstBuildData = firstBuildResult
      ? (result.history.verificationResults.find(
          (v) => v.iteration === firstBuildResult.iteration,
        ) ?? null)
      : null;
    // Build tool does not throw on failure; instead it returns an error
    // manifest. Verify the agent correctly observed and handled the failure.
    expect(firstBuildData).not.toBeNull();
    expect(result.history.verificationResults.at(-1)?.passed).toBe(true);
  });

  it("5. stops after the maximum iterations when the build never succeeds", async () => {
    const alwaysFailBuild = async (projectId: string): Promise<BuildFailure> => {
      const failure: BuildFailure = {
        status: "error",
        projectId,
        workspace: workspaceDir(projectId),
        errors: [
          {
            file: "index.html",
            code: "malformed-html",
            message: "Permanent simulated failure.",
          },
        ],
        builtAt: new Date().toISOString(),
      };
      await writeBuildManifest(projectId, failure);
      return failure;
    };

    const agent = createWebsiteCodingAgent({ build: alwaysFailBuild });
    const result = await runAgentLoop({
      agent,
      context: codingContext({ projectId: "acme-plumbing" }),
      controller,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe(MAX_ITERATIONS_REASON);
    expect(result.iteration).toBeLessThanOrEqual(8);
  });

  it("6. paused jobs do not continue until resumed", async () => {
    const agent = createWebsiteCodingAgent();
    const projectId = "acme-plumbing";
    controller.requestPause();

    const job = runAgentLoop({
      agent,
      context: codingContext({ projectId }),
      controller,
    });

    await sleep(60);
    expect(existsSync(workspaceDir(projectId))).toBe(false);

    controller.resume();
    const result = await job;
    expect(result.status).toBe("completed");

    const files = await listWorkspaceFiles(projectId);
    expect(files.length).toBeGreaterThan(0);
  });

  it("7. stopped jobs stop immediately without further work", async () => {
    const agent = createWebsiteCodingAgent();
    controller.requestStop();

    const result = await runAgentLoop({
      agent,
      context: codingContext({ projectId: "acme-plumbing" }),
      controller,
    });

    expect(result.status).toBe("stopped");
    expect(result.error).toMatch(/stopped/);
    expect(result.history.actions.length).toBe(0);
  });

  it("8. verification is required before the loop completes", async () => {
    const agent = createWebsiteCodingAgent();
    const result = await runAgentLoop({
      agent,
      context: codingContext({ projectId: "acme-plumbing" }),
      controller,
    });

    expect(result.status).toBe("completed");
    const verifications = result.history.verificationResults;
    expect(verifications.length).toBeGreaterThan(0);
    // Last action must be the final validate step.
    expect(result.history.actions.at(-1)?.name).toBe("website.validate");
    // Every requirement passes in the final verification.
    const final = verifications.at(-1)!;
    expect(final.passed).toBe(true);
  });

  it("9. no deploy permission is available", async () => {
    const agent = createWebsiteCodingAgent();
    const toolbox = new AgentToolbox(agent.tools ?? [], agent.permissions);
    await expect(
      toolbox.run(
        { name: "workspace.create", permission: "deploy", input: { projectId: "x" } },
        codingContext(),
      ),
    ).rejects.toThrow(PermissionError);
  });

  it("10. arbitrary shell commands are rejected", async () => {
    const agent = createWebsiteCodingAgent();
    const toolbox = new AgentToolbox(agent.tools ?? [], agent.permissions);
    await expect(
      toolbox.run(
        { name: "run-shell", permission: "execute", input: { command: "rm -rf /" } },
        codingContext(),
      ),
    ).rejects.toThrow(ToolNotFoundError);
  });

  it("11. workspace paths outside the workspace are rejected", async () => {
    const agent = createWebsiteCodingAgent();
    const tool = agent.tools?.find((t) => t.name === "workspace.write");
    expect(tool).toBeDefined();

    await expect(
      tool!.execute!(
        {
          projectId: "acme-plumbing",
          files: [{ path: "../.env.local", content: "SECRET=1" }],
        },
        codingContext(),
      ),
    ).rejects.toThrow(WorkspacePathError);

    await expect(
      tool!.execute!(
        {
          projectId: "acme-plumbing",
          files: [{ path: "/tmp/evil.conf", content: "boom" }],
        },
        codingContext(),
      ),
    ).rejects.toThrow(WorkspacePathError);
  });

  it("12. invalid project ids are rejected at the workspace layer", () => {
    expect(() => assertSafeProjectId("../evil")).toThrow(
      WorkspaceProjectIdError,
    );
    expect(() => assertSafeProjectId("has space")).toThrow(
      WorkspaceProjectIdError,
    );
    expect(() => assertSafeProjectId("acme-plumbing")).not.toThrow();
  });

  it("13. unrelated application files cannot be modified", async () => {
    const agent = createWebsiteCodingAgent();
    const result = await runAgentLoop({
      agent,
      context: codingContext({ projectId: "acme-plumbing" }),
      controller,
    });
    expect(result.status).toBe("completed");

    // No file was written outside the workspace.
    const names = (await listWorkspaceFiles("acme-plumbing")).map((f) => f.path);
    for (const name of names) {
      expect(name.startsWith("..")).toBe(false);
      expect(name.startsWith("/")).toBe(false);
      expect(/^acme-plumbing\//.test(name) || /^[^/]+$/.test(name)).toBe(true);
    }
    // A hostile path can never be produced by the agent's writes.
    expect(names).not.toContain("../../src/app/page.tsx");
  });

  it("14. no fabricated facts with controlled input", async () => {
    const agent = createWebsiteCodingAgent();
    const lead = {
      ...makeLead("p1", "Acme Plumbing"),
      internationalPhoneNumber: undefined as string | undefined,
      nationalPhoneNumber: undefined as string | undefined,
    };
    const result = await runAgentLoop({
      agent,
      context: {
        goal: { description: "Create a website", acceptanceCriteria: [] },
        references: {
          lead,
          research: makeResearch(),
          contact: testContact(),
          projectId: "acme-plumbing",
        },
      },
      controller,
    });
    expect(result.status).toBe("completed");

    const allHtml = (
      await listWorkspaceFiles("acme-plumbing")
    )
      .filter((f) => f.path.endsWith(".html"))
      .map((f) => readFileSync(path.join(workspaceDir("acme-plumbing"), f.path), "utf8"))
      .join("\n");
    const index = readFileSync(
      path.join(workspaceDir("acme-plumbing"), "index.html"),
      "utf8",
    );

    // Verified facts are present.
    expect(allHtml).toContain("Acme Plumbing");
    expect(allHtml).toContain("mailto:office@acme.test");
    expect(allHtml).toContain("tel:+1 555 0100");
    expect(allHtml).toContain("1 Main St");

    // Fabricated or invented content is absent.
    expect(index).not.toMatch(/lorem ipsum/i);
    expect(allHtml).not.toContain("sales@acme.test");
    expect(allHtml).not.toMatch(/\d+\s+reviews?/i);
  });

  it("15. a plan requires a qualified prospect and research", async () => {
    const agent = createWebsiteCodingAgent();
    const emptyCtx: AgentContext = {
      goal: { description: "Create a website", acceptanceCriteria: [] },
      constraints: [],
    };
    await expect(
      runAgentLoop({ agent, context: emptyCtx, controller }),
    ).rejects.toThrow(/references.lead/);
  });

  it("team writes and rewrites are byte-deterministic and idempotent", async () => {
    const agent = createWebsiteCodingAgent();
    const projectId = "acme-plumbing";
    const tool = agent.tools?.find((t) => t.name === "workspace.write");
    expect(tool).toBeDefined();

    const rendered = renderSiteSource(
      {
        lead: makeLead("p1", "Acme Plumbing"),
        research: makeResearch(),
        contact: testContact(),
      },
      projectId,
    );
    await tool!.execute!(
      { projectId, files: rendered.files },
      codingContext(),
    );
    const first = await listWorkspaceFiles(projectId);
    await tool!.execute!(
      { projectId, files: rendered.files },
      codingContext(),
    );
    const second = await listWorkspaceFiles(projectId);
    expect(second).toEqual(first);
  });
});