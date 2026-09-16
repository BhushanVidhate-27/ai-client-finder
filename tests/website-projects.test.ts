import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDatabase } from "@/lib/data/schema";
import { getDb } from "@/lib/data/db";
import { JobController, JobStoppedError } from "@/lib/jobs/controller";
import { runWebsiteProjectGeneration } from "@/lib/jobs/website-project-flow";
import {
  computeSourceHash,
  hashWorkspace,
} from "@/lib/website-coding/source-hash";
import {
  assertSafeProjectId,
  readWorkspaceFile,
  writeWorkspaceFiles,
  workspaceDir,
  WorkspacePathError,
  getWorkspaceFilesWithContent,
  readBuildManifest,
} from "@/lib/website-coding/workspace";
import {
  countWebsiteVersions,
  createWebsiteProjectVersion,
  ensureWebsiteProject,
  getCurrentWebsiteVersion,
  getWebsiteProjectDetail,
  getWebsiteProjectRecord,
  getWebsiteProjectRecordByLeadId,
  getWebsiteVersion,
  listWebsiteProjectVersions,
  listWebsiteProjects,
  markWebsiteVersionFailed,
  markWebsiteVersionStopped,
  promoteWebsiteVersion,
  updateWebsiteVersionResult,
  WebsitePromotionError,
  WebsiteVersionTransitionError,
  type WebsiteVersionRow,
} from "@/lib/data/websites";
import { createWebsiteCodingAgent } from "@/lib/website-coding/agent";
import { createSessionToken } from "@/lib/auth/session";
import { makeLead, makeResearch } from "./helpers";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import type { Agent, AgentContext } from "@/lib/agents/types";
import type { QualifiedLead } from "@/lib/lead-qualification";

function testContact(): ContactDiscovery {
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
  };
}

function flowInput(lead: QualifiedLead, controller: JobController) {
  return {
    leadId: lead.placeId,
    lead,
    contact: testContact(),
    research: makeResearch(),
    controller,
  };
}

function seedLead(placeId: string, businessName: string): string {
  const lead = makeLead(placeId, businessName);
  return String(lead.placeId);
}

function makeReady(versionId: string): void {
  updateWebsiteVersionResult(versionId, { status: "building", buildStatus: "building" });
  updateWebsiteVersionResult(versionId, { status: "qa", qaStatus: "qa" });
  updateWebsiteVersionResult(versionId, { status: "ready", buildStatus: "success", qaStatus: "pass" });
}

async function writeVersionFiles(workspaceId: string, layer: string): Promise<void> {
  await writeWorkspaceFiles(workspaceId, [
    { path: "index.html", content: `<h1>${layer}</h1>` },
    { path: "styles.css", content: layer },
  ]);
}

function makeFailingAgent(): Agent {
  const permissive = {
    permissions: ["read", "write", "execute"] as const,
    tools: [],
    planner: undefined,
    plan() {
      return {
        objective: "fail",
        constraints: [],
        acceptanceCriteria: [],
        steps: [{ id: "s", label: "s" }],
        allowedActions: [],
        verificationRequirements: [],
        maxIterations: 8,
      };
    },
    inspect() {
      return { id: "obs", iteration: 0, description: "noop", at: new Date().toISOString() };
    },
    decide() {
      return { name: "missing.tool", permission: "read" as const };
    },
    verify() {
      return {
        id: "ver",
        iteration: 0,
        passed: false,
        checks: [],
        at: new Date().toISOString(),
      };
    },
  };
  return permissive as unknown as Agent;
}

function controllableCodingAgent(
  controller: JobController,
  hook: (controller: JobController) => void,
  stopOnDecide = false,
): Agent {
  const real = createWebsiteCodingAgent();
  let armed = false;
  return {
    ...real,
    async decide(
      context: AgentContext,
      state: Parameters<typeof real.decide>[1],
      observation: Parameters<typeof real.decide>[2],
    ) {
      if (!armed) {
        armed = true;
        if (stopOnDecide) controller.requestStop();
        else hook(controller);
      }
      return real.decide(context, state, observation);
    },
  };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "acf-website-projects-"));
  process.env.WORKSPACES_ROOT = tmpRoot;
  process.env.SESSION_SECRET = "test-secret";
  resetDatabase(getDb());
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.WORKSPACES_ROOT;
});

async function runDemoFlow(leadId: string) {
  const lead = makeLead(`pl-${leadId}`, "Demo Co");
  const controller = new JobController(`job-${leadId}`);
  return runWebsiteProjectGeneration({
    leadId,
    lead,
    contact: testContact(),
    research: makeResearch(),
    controller,
  });
}

describe("Website project persistence (Step 12)", () => {
  it("1. ensureWebsiteProject creates exactly one project per lead (keyed by lead id)", () => {
    const leadId = seedLead("p1", "Acme Plumbing");
    expect(getWebsiteProjectRecordByLeadId(leadId)).toBeNull();

    const project = ensureWebsiteProject(leadId);
    expect(project.leadId).toBe(leadId);
    expect(project.currentVersion).toBe(0);
    expect(project.status).toBe("active");
    expect(getWebsiteProjectRecord(project.projectId)?.projectId).toBe(project.projectId);
    expect(listWebsiteProjects()).toHaveLength(1);
  });

  it("2. ensureWebsiteProject is idempotent (reuses the existing project)", () => {
    const leadId = seedLead("p2", "Acme Plumbing");
    const first = ensureWebsiteProject(leadId);
    const second = ensureWebsiteProject(leadId);
    expect(second.projectId).toBe(first.projectId);
    expect(listWebsiteProjects()).toHaveLength(1);
  });

  it("3. project identity is the lead, never the business name", () => {
    const leadA = seedLead("p3", "Same Name Co");
    const leadB = seedLead("p4", "Same Name Co");
    const projectA = ensureWebsiteProject(leadA);
    const projectB = ensureWebsiteProject(leadB);
    expect(projectA.projectId).not.toBe(projectB.projectId);
    expect(projectA.leadId).toBe(leadA);
    expect(projectB.leadId).toBe(leadB);
  });

  it("4. version numbers / status / current are server-computed, not client-controlled", () => {
    const leadId = seedLead("p5", "Acme Plumbing");
    const project = ensureWebsiteProject(leadId);
    const draft = createWebsiteProjectVersion(leadId);
    expect(draft.version).toBe(1);
    expect(draft.status).toBe("draft");
    expect(draft.websiteProjectId).toBe(project.projectId);
    expect(draft.isCurrent).toBe(false);
    expect(draft.buildStatus).toBe("pending");
    expect(draft.qaStatus).toBe("pending");
    expect(draft.project).toBeNull();
    expect(draft.artifactHash).toBeNull();
    expect(countWebsiteVersions(leadId)).toBe(1);
  });

  it("5. version counters increment per project (v1 then v2)", () => {
    const leadId = seedLead("p6", "Acme");
    const v1 = createWebsiteProjectVersion(leadId);
    const v2 = createWebsiteProjectVersion(leadId);
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v1.projectId).not.toBe(v2.projectId);
    expect(v1.workspaceId).not.toBe(v2.workspaceId);
  });

  it("6. version numbers are independent per project (two leads both get v1)", () => {
    const leadA = seedLead("p7", "A");
    const leadB = seedLead("p8", "B");
    expect(createWebsiteProjectVersion(leadA).version).toBe(1);
    expect(createWebsiteProjectVersion(leadB).version).toBe(1);
  });

  it("7. version numbers are never reused (a manually inserted v2 forces v3)", () => {
    const leadId = seedLead("p9", "Acme");
    const v1 = createWebsiteProjectVersion(leadId);
    const v2 = createWebsiteProjectVersion(leadId);
    expect(v2.version).toBe(2);

    const inserted = getDb()
      .prepare(
        "INSERT INTO website_versions (id, project_id, lead_id, version, status, website_project_json, is_current, created_at, updated_at) VALUES (?, ?, ?, 3, 'draft', '{}', 0, ?, ?)",
      )
      .run("forced-v3", v1.websiteProjectId, leadId, new Date().toISOString(), new Date().toISOString());
    expect(Number(inserted.changes)).toBe(1);

    const v4 = createWebsiteProjectVersion(leadId);
    expect(v4.version).toBe(4);
  });

  it("8. parallel version creation yields unique, monotonic version numbers", async () => {
    const leadId = seedLead("p10", "Acme");
    await Promise.all(
      Array.from({ length: 6 }, () => Promise.resolve(createWebsiteProjectVersion(leadId))),
    );
    const detail = getWebsiteProjectDetail(leadId)!;
    expect(detail.versions).toHaveLength(6);
    const numbers = detail.versions.map((v) => v.version);
    expect(new Set(numbers).size).toBe(6);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
    for (const row of detail.versions) {
      expect(row.websiteProjectId).toBe(detail.project.projectId);
    }
  });

  it("9. getWebsiteProjectDetail returns the project, ascending versions, and no current before promotion", () => {
    const leadId = seedLead("p11", "Acme");
    const project = ensureWebsiteProject(leadId);
    const draft = createWebsiteProjectVersion(leadId);
    createWebsiteProjectVersion(leadId);

    const detail = getWebsiteProjectDetail(leadId)!;
    expect(detail.project.projectId).toBe(project.projectId);
    expect(detail.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(detail.versions[0].projectId).toBe(draft.projectId);
    expect(detail.currentVersion).toBeNull();
    expect(listWebsiteProjectVersions(project.projectId).map((v) => v.version)).toEqual([1, 2]);
  });

  it("10. version statuses use legal transitions only", () => {
    const leadId = seedLead("p12", "Acme");
    const version = createWebsiteProjectVersion(leadId);

    expect(() =>
      updateWebsiteVersionResult(version.projectId, { status: "qa" }),
    ).toThrow(WebsiteVersionTransitionError);

    expect(updateWebsiteVersionResult(version.projectId, { status: "building" }).status).toBe(
      "building",
    );
    expect(
      updateWebsiteVersionResult(version.projectId, { status: "qa" }).status,
    ).toBe("qa");
    expect(
      updateWebsiteVersionResult(version.projectId, { status: "ready" }).status,
    ).toBe("ready");

    expect(() =>
      updateWebsiteVersionResult(version.projectId, { status: "stopped" }),
    ).not.toThrow();
    expect(() =>
      updateWebsiteVersionResult(version.projectId, { status: "draft" }),
    ).toThrow(WebsiteVersionTransitionError);
    expect(() =>
      updateWebsiteVersionResult(version.projectId, { status: "failed" }),
    ).toThrow(WebsiteVersionTransitionError);
  });

  it("11. build status auto-advances a draft to building, and build+qa to ready", () => {
    const leadId = seedLead("p13", "Acme");
    const version = createWebsiteProjectVersion(leadId);

    let row = updateWebsiteVersionResult(version.projectId, { buildStatus: "building" });
    expect(row.status).toBe("building");
    expect(row.buildStatus).toBe("building");

    row = updateWebsiteVersionResult(version.projectId, {
      buildStatus: "success",
      qaStatus: "pass",
      artifactHash: "abc123",
      metadata: { businessName: "Acme" },
    });
    expect(row.status).toBe("ready");
    expect(row.buildStatus).toBe("success");
    expect(row.qaStatus).toBe("pass");
    expect(row.artifactHash).toBe("abc123");
    expect(row.metadata.businessName).toBe("Acme");
    expect(updateWebsiteVersionResult(version.projectId, { status: "failed" }).status).toBe(
      "failed",
    );
  });

  it("12. failed and stopped versions cannot be promoted", () => {
    const leadId = seedLead("p14", "Acme");
    const version = createWebsiteProjectVersion(leadId);
    markWebsiteVersionFailed(version.projectId);
    expect(() => promoteWebsiteVersion(version.projectId)).toThrow(WebsiteVersionTransitionError);

    const stopped = createWebsiteProjectVersion(leadId);
    markWebsiteVersionStopped(stopped.projectId);
    expect(() => promoteWebsiteVersion(stopped.projectId)).toThrow(WebsiteVersionTransitionError);
  });

  it("13. promotion requires build success and QA pass", () => {
    const leadId = seedLead("p15", "Acme");
    const version = createWebsiteProjectVersion(leadId);
    updateWebsiteVersionResult(version.projectId, { status: "building", buildStatus: "building" });
    updateWebsiteVersionResult(version.projectId, { status: "qa", qaStatus: "qa" });
    updateWebsiteVersionResult(version.projectId, {
      status: "ready",
      buildStatus: "success",
      qaStatus: "pending",
    });
    expect(() => promoteWebsiteVersion(version.projectId)).toThrow(WebsiteVersionTransitionError);
  });

  it("14. promoting a ready version makes it current and updates the project", () => {
    const leadId = seedLead("p16", "Acme");
    const version = createWebsiteProjectVersion(leadId);
    makeReady(version.projectId);

    const promoted = promoteWebsiteVersion(version.projectId);
    expect(promoted.status).toBe("current");
    expect(promoted.isCurrent).toBe(true);
    expect(getCurrentWebsiteVersion(leadId)?.projectId).toBe(version.projectId);
    expect(getWebsiteProjectRecordByLeadId(leadId)!.currentVersion).toBe(1);
    expect(getWebsiteProjectDetail(leadId)!.currentVersion?.version).toBe(1);
  });

  it("15. promotion is atomic and leaves exactly one current version", () => {
    const leadId = seedLead("p17", "Acme");
    const v1 = createWebsiteProjectVersion(leadId);
    const v2 = createWebsiteProjectVersion(leadId);

    for (const version of [v1, v2]) {
      makeReady(version.projectId);
    }

    const promoted = promoteWebsiteVersion(v2.projectId);
    expect(promoted.isCurrent).toBe(true);

    const rows = listWebsiteProjectVersions(v1.websiteProjectId!);
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
    expect(getCurrentWebsiteVersion(leadId)?.version).toBe(2);
    expect(getWebsiteProjectRecordByLeadId(leadId)!.currentVersion).toBe(2);
  });

  it("16. demoting the old current leaves it as a ready, non-current version", () => {
    const leadId = seedLead("p18", "Acme");
    const v1 = createWebsiteProjectVersion(leadId);
    const v2 = createWebsiteProjectVersion(leadId);
    for (const version of [v1, v2]) {
      makeReady(version.projectId);
    }
    promoteWebsiteVersion(v1.projectId);
    promoteWebsiteVersion(v2.projectId);

    const demoted = getWebsiteVersion(v1.projectId)!;
    expect(demoted.isCurrent).toBe(false);
    expect(demoted.status).toBe("ready");
  });

  it("17. re-promoting the current version is idempotent", () => {
    const leadId = seedLead("p19", "Acme");
    const version = createWebsiteProjectVersion(leadId);
    makeReady(version.projectId);
    promoteWebsiteVersion(version.projectId);
    const again = promoteWebsiteVersion(version.projectId);
    expect(again.status).toBe("current");
    expect(getWebsiteProjectRecordByLeadId(leadId)!.currentVersion).toBe(1);
  });

  it("18. a failed newer version never overwrites the current version", () => {
    const leadId = seedLead("p20", "Acme");
    const v1 = createWebsiteProjectVersion(leadId);
    makeReady(v1.projectId);
    const promoted = promoteWebsiteVersion(v1.projectId);
    expect(promoted.status).toBe("current");

    const v2 = createWebsiteProjectVersion(leadId);
    markWebsiteVersionFailed(v2.projectId);

    expect(getCurrentWebsiteVersion(leadId)?.projectId).toBe(v1.projectId);
    expect(getWebsiteProjectRecordByLeadId(leadId)!.currentVersion).toBe(1);
    expect(getWebsiteVersion(v2.projectId)!.status).toBe("failed");
  });

  it("19. promoting an unbound (non-project) version is rejected", () => {
    getDb()
      .prepare(
        "INSERT INTO website_versions (id, lead_id, version, status, website_project_json, is_current, created_at, updated_at) VALUES (?, ?, 1, 'ready', '{}', 0, ?, ?)",
      )
      .run("unbound-1", "unbound-lead", new Date().toISOString(), new Date().toISOString());
    expect(() => promoteWebsiteVersion("unbound-1")).toThrow(WebsitePromotionError);
  });

  it("20. workspace ids are deterministic, slug-safe, and map under the workspaces root", () => {
    const leadId = seedLead("p21", "Acme");
    const v1 = createWebsiteProjectVersion(leadId);
    expect(assertSafeProjectId(v1.workspaceId!)).toBe(v1.workspaceId);
    expect(workspaceDir(v1.workspaceId!)).toBe(
      path.join(tmpRoot, v1.workspaceId!),
    );
    const v2 = createWebsiteProjectVersion(leadId);
    expect(v1.workspaceId).toBe(`${ensureWebsiteProject(leadId).projectId}-v1`);
    expect(v2.workspaceId).toBe(`${ensureWebsiteProject(leadId).projectId}-v2`);
  });

  it("21. version workspaces are isolated from one another", async () => {
    const leadId = seedLead("p22", "Acme");
    const v1 = createWebsiteProjectVersion(leadId);
    const v2 = createWebsiteProjectVersion(leadId);
    await writeVersionFiles(v1.workspaceId!, "v1-content");
    await writeVersionFiles(v2.workspaceId!, "v2-content");

    expect(await readWorkspaceFile(v1.workspaceId!, "index.html")).toContain("v1-content");
    expect(await readWorkspaceFile(v2.workspaceId!, "index.html")).toContain("v2-content");
    expect(existsSync(path.join(workspaceDir(v1.workspaceId!), "styles.css"))).toBe(true);
    expect(
      (await getWorkspaceFilesWithContent(v1.workspaceId!)).map((f) => f.path),
    ).not.toContain("other/index.html");
  });

  it("22. workspace path traversal is rejected for version workspaces", async () => {
    const leadId = seedLead("p23", "Acme");
    const v1 = createWebsiteProjectVersion(leadId);
    await writeVersionFiles(v1.workspaceId!, "x");
    await expect(readWorkspaceFile(v1.workspaceId!, "../app.sqlite")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  it("23. computeSourceHash is deterministic and order-independent", () => {
    const filesA = [
      { path: "b.html", content: "bbb" },
      { path: "a.css", content: "aaa" },
    ];
    const filesB = [
      { path: "a.css", content: "aaa" },
      { path: "b.html", content: "bbb" },
    ];
    expect(computeSourceHash(filesA)).toBe(computeSourceHash(filesB));
    expect(computeSourceHash(filesA)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("24. computeSourceHash changes when any content or file changes", () => {
    const base = [
      { path: "index.html", content: "hello" },
      { path: "styles.css", content: "body{}" },
    ];
    const changed = computeSourceHash(base);
    expect(computeSourceHash([{ path: "index.html", content: "hello!" }, { path: "styles.css", content: "body{}" }])).not.toBe(changed);
    expect(computeSourceHash([{ path: "index.html", content: "hello" }])).not.toBe(changed);
    expect(computeSourceHash([{ path: "index.html", content: "hello" }, { path: "styles.css", content: "body{}" }, { path: "script.js", content: "" }])).not.toBe(changed);
  });

  it("25. hashWorkspace equals computeSourceHash over the same files", async () => {
    const leadId = seedLead("p25", "Acme");
    const v1 = createWebsiteProjectVersion(leadId);
    await writeVersionFiles(v1.workspaceId!, "content");
    const files = await getWorkspaceFilesWithContent(v1.workspaceId!);
    expect(await hashWorkspace(v1.workspaceId!)).toBe(computeSourceHash(files));
  });
});

describe("Website project generation flow (Step 12)", () => {
  it("26. full lifecycle: coding + QA agents produce a promoted current version", async () => {
    const leadId = seedLead("p26", "Acme Plumbing");
    const result = await runDemoFlow(leadId);

    expect(result.status).toBe("current");
    expect(result.version).toBe(1);
    expect(result.buildStatus).toBe("success");
    expect(result.qaStatus).toBe("pass");
    expect(result.artifactHash).toMatch(/^[0-9a-f]{64}$/);

    const project = getWebsiteProjectRecordByLeadId(leadId)!;
    expect(project.currentVersion).toBe(1);
    const current = getCurrentWebsiteVersion(leadId)!;
    expect(current.projectId).toBe(result.projectId);
    expect(current.isCurrent).toBe(true);

    const files = await getWorkspaceFilesWithContent(result.workspaceId);
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(["index.html", "styles.css", "script.js", "package.json"]),
    );
    const manifest = await readBuildManifest(result.workspaceId);
    expect(manifest?.status).toBe("success");
  });

  it("27. a second run produces v2 and demotes v1", async () => {
    const leadId = seedLead("p27", "Acme Plumbing");
    await runDemoFlow(leadId);
    const second = await runDemoFlow(leadId);

    expect(second.version).toBe(2);
    expect(getWebsiteProjectRecordByLeadId(leadId)!.currentVersion).toBe(2);
    const versions = listWebsiteProjectVersions(ensureWebsiteProject(leadId).projectId);
    expect(versions.filter((v) => v.isCurrent)).toHaveLength(1);
    expect(getCurrentWebsiteVersion(leadId)!.version).toBe(2);
  });

  it("28. a stop requested before starting persists nothing", async () => {
    const leadId = seedLead("p28", "Acme");
    const controller = new JobController("job-stop-before");
    controller.requestStop();
    await expect(runWebsiteProjectGeneration(flowInput(makeLead("p28", "Acme"), controller))).rejects.toThrow(
      JobStoppedError,
    );
    expect(getWebsiteProjectRecordByLeadId(leadId)).toBeNull();
    expect(countWebsiteVersions(leadId)).toBe(0);
  });

  it("29. a stop during coding persists the version as stopped and never promotes", async () => {
    const leadId = seedLead("p29", "Acme");
    const controller = new JobController("job-stop-mid");
    const codings = controllableCodingAgent(controller, () => undefined, true);

    await expect(
      runWebsiteProjectGeneration(
        {
          ...flowInput(makeLead("p29", "Acme"), controller),
          leadId,
        },
        { codingAgent: codings },
      ),
    ).rejects.toThrow(JobStoppedError);

    const versions = listWebsiteProjectVersions(ensureWebsiteProject(leadId).projectId);
    expect(versions).toHaveLength(1);
    expect(versions[0].status).toBe("stopped");
    expect(versions[0].isCurrent).toBe(false);
    expect(getWebsiteProjectRecordByLeadId(leadId)!.currentVersion).toBe(0);
  });

  it("30. stopping a second run leaves the previous current version intact", async () => {
    const leadId = seedLead("p30", "Acme");
    await runDemoFlow(leadId);
    const v1 = getCurrentWebsiteVersion(leadId)!;

    const controller = new JobController("job-stop-second");
    const codings = controllableCodingAgent(controller, () => undefined, true);
    await expect(
      runWebsiteProjectGeneration(
        { ...flowInput(makeLead("p30", "Acme"), controller), leadId },
        { codingAgent: codings },
      ),
    ).rejects.toThrow(JobStoppedError);

    expect(getCurrentWebsiteVersion(leadId)!.projectId).toBe(v1.projectId);
    expect(getWebsiteProjectRecordByLeadId(leadId)!.currentVersion).toBe(1);
    const versions = listWebsiteProjectVersions(ensureWebsiteProject(leadId).projectId);
    expect(versions.map((v) => v.status)).toEqual(["current", "stopped"]);
  });

  it("31. pause during coding then resume completes with a single version row", async () => {
    const leadId = seedLead("p31", "Acme");
    const controller = new JobController("job-pause-mid");
    const codings = controllableCodingAgent(controller, (c) => c.requestPause(), false);

    const running = runWebsiteProjectGeneration(
      { ...flowInput(makeLead("p31", "Acme"), controller), leadId },
      { codingAgent: codings },
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    const duringPause = listWebsiteProjectVersions(ensureWebsiteProject(leadId).projectId);
    expect(duringPause).toHaveLength(1);
    expect(duringPause[0].status).toBe("building");

    controller.resume();
    const result = await running;
    expect(result.status).toBe("current");
    expect(result.version).toBe(1);
    // Resume must not create a duplicate version row.
    expect(countWebsiteVersions(leadId)).toBe(1);
  });

  it("32. a failing coding/QA run persists the version as failed", async () => {
    const leadId = seedLead("p32", "Acme");
    const controller = new JobController("job-fail");
    await expect(
      runWebsiteProjectGeneration(
        { ...flowInput(makeLead("p32", "Acme"), controller), leadId },
        { codingAgent: makeFailingAgent() },
      ),
    ).rejects.toThrow();

    const versions = listWebsiteProjectVersions(ensureWebsiteProject(leadId).projectId);
    expect(versions).toHaveLength(1);
    expect(versions[0].status).toBe("failed");
    expect(versions[0].isCurrent).toBe(false);
    expect(getCurrentWebsiteVersion(leadId)).toBeNull();
  });
});

describe("Website project API (Step 12)", () => {
  async function authorizedGet(
    url: string,
  ): Promise<{ status: number; json: () => Promise<Record<string, unknown>> }> {
    const token = await createSessionToken("admin");
    const request = new Request(url, {
      headers: { cookie: `aicf_session=${encodeURIComponent(token)}` },
    });
    const { GET } = await import("@/app/api/admin/website-projects/[leadId]/route");
    const respond = await GET(request, { params: Promise.resolve({ leadId: url.split("/").pop()! }) } as never);
    return { status: respond.status, json: () => respond.json() as Promise<Record<string, unknown>> };
  }

  it("33. GET website project requires authentication", async () => {
    const request = new Request("http://localhost/api/admin/website-projects/lead-x");
    const { GET } = await import("@/app/api/admin/website-projects/[leadId]/route");
    const respond = await GET(request, { params: Promise.resolve({ leadId: "lead-x" }) } as never);
    expect(respond.status).toBe(401);
  });

  it("34. GET website project returns project, versions, and current version", async () => {
    const leadId = seedLead("p34", "Acme");
    await runDemoFlow(leadId);
    const detail = getWebsiteProjectDetail(leadId)!;

    const response = await authorizedGet(`http://localhost/api/admin/website-projects/${leadId}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.project).toMatchObject({
      leadId,
      currentVersion: 1,
      status: "active",
    });
    expect((body.versions as WebsiteVersionRow[]).map((v) => v.version)).toEqual([1]);
    expect((body.currentVersion as WebsiteVersionRow).isCurrent).toBe(true);
    expect(detail.currentVersion?.version).toBe(1);
  });

  it("35. GET versions and GET current endpoints report per-project state", async () => {
    const leadId = seedLead("p35", "Acme");
    await runDemoFlow(leadId);

    const { GET: getVersions } = await import(
      "@/app/api/admin/website-projects/[leadId]/versions/route"
    );
    const { GET: getCurrent } = await import(
      "@/app/api/admin/website-projects/[leadId]/current/route"
    );
    const token = await createSessionToken("admin");
    const ok = (sub: string) =>
      new Request(`http://localhost/api/admin/website-projects/${leadId}/${sub}`, {
        headers: { cookie: `aicf_session=${encodeURIComponent(token)}` },
      });

    const versionsRes = await getVersions(ok("versions"), {
      params: Promise.resolve({ leadId }),
    } as never);
    const versionsBody = (await versionsRes.json()) as { versions: WebsiteVersionRow[] };
    expect(versionsBody.versions.map((v) => v.version)).toEqual([1]);

    const currentRes = await getCurrent(ok("current"), {
      params: Promise.resolve({ leadId }),
    } as never);
    const currentBody = (await currentRes.json()) as { currentVersion: WebsiteVersionRow };
    expect(currentBody.currentVersion.version).toBe(1);
    expect(currentBody.currentVersion.isCurrent).toBe(true);
  });
});

describe("Website project adversarial scenarios (Step 12)", () => {
  it("A. concurrent version creation never corrupts the project", async () => {
    const leadId = seedLead("pA", "Acme");
    const project = ensureWebsiteProject(leadId);
    await Promise.all(
      Array.from({ length: 5 }, () => Promise.resolve(createWebsiteProjectVersion(leadId))),
    );
    const versions = listWebsiteProjectVersions(project.projectId);
    expect(new Set(versions.map((v) => v.version)).size).toBe(5);
    expect(versions.map((v) => v.websiteProjectId).every((id) => id === project.projectId)).toBe(true);
  });

  it("B. a client-supplied version number cannot create a second current version", () => {
    const leadId = seedLead("pB", "Acme");
    const v1 = createWebsiteProjectVersion(leadId);
    makeReady(v1.projectId);
    promoteWebsiteVersion(v1.projectId);

    // A forced direct INSERT of another current (e.g. version 999) must be
    // rejected by the one-current-per-project partial unique index, so an
    // over-aggressive client can never create two current versions.
    expect(() => {
      getDb()
        .prepare(
          "INSERT INTO website_versions (id, project_id, lead_id, version, status, website_project_json, is_current, created_at, updated_at) VALUES (?, ?, ?, 999, 'ready', '{}', 1, ?, ?)",
        )
        .run("forced-999", leadId, leadId, new Date().toISOString(), new Date().toISOString());
    }).toThrow();
    const current = listWebsiteProjectVersions(ensureWebsiteProject(leadId).projectId).filter(
      (v) => v.isCurrent,
    );
    expect(current).toHaveLength(1);
    expect(getWebsiteProjectRecordByLeadId(leadId)!.currentVersion).toBe(1);
  });

  it("C. workspace artifacts cannot escape the workspace root", async () => {
    const leadId = seedLead("pC", "Acme");
    const v1 = createWebsiteProjectVersion(leadId);
    await writeVersionFiles(v1.workspaceId!, "data");
    let escaped: string | null = null;
    try {
      escaped = await readWorkspaceFile(v1.workspaceId!, "../../.env");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspacePathError);
    }
    expect(escaped).toBeNull();
    const root = workspaceDir(v1.workspaceId!);
    expect(root.startsWith(tmpRoot)).toBe(true);
    expect(existsSync(path.join(root, "../../.env"))).toBe(false);
  });

  it("D. hash never includes timestamps or environment values", () => {
    const files = [{ path: "index.html", content: "x" }];
    const first = computeSourceHash(files);
    const second = computeSourceHash(files);
    expect(second).toBe(first);
  });

  it("E. duplicate review of a version cannot create two current versions", async () => {
    const leadId = seedLead("pE", "Acme");
    const v1 = createWebsiteProjectVersion(leadId);
    makeReady(v1.projectId);
    promoteWebsiteVersion(v1.projectId);
    promoteWebsiteVersion(v1.projectId);
    const current = listWebsiteProjectVersions(v1.websiteProjectId!).filter((v) => v.isCurrent);
    expect(current).toHaveLength(1);
  });

  it("F. version persistence reads never expose workspace internals beyond metadata", async () => {
    const leadId = seedLead("pF", "Acme");
    await writeVersionFiles(`${ensureWebsiteProject(leadId).projectId}-v9`, "ghost");
    const v1 = createWebsiteProjectVersion(leadId);
    expect(v1.workspaceId).toBe(`${ensureWebsiteProject(leadId).projectId}-v1`);
    const row = getWebsiteVersion(v1.projectId)!;
    expect(row.project).toBeNull();
    expect(row.websiteProjectId).toBe(ensureWebsiteProject(leadId).projectId);
  });
});