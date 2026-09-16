import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDatabase } from "@/lib/data/schema";
import { getDb } from "@/lib/data/db";
import { createWebsiteProjectVersion } from "@/lib/data/websites";
import {
  createDeploymentRecord,
  updateDeploymentRecord,
  markDeploymentFailed,
  markDeploymentCancelled,
  getDeploymentRecord,
  listDeploymentRecordsByLead,
  getActiveDeploymentForProject,
  hasActiveDeploymentForProject,
  DeploymentTransitionError,
  isActiveDeploymentStatus,
} from "@/lib/data/deployments";

function testWebsiteProject(tag: string): {
  projectId: string;
  leadId: string;
  versionId: string;
} {
  const leadId = `place-${tag}`;
  const version = createWebsiteProjectVersion(leadId);
  return {
    projectId: version.websiteProjectId!,
    leadId,
    versionId: version.projectId,
  };
}

/** Advances a record through the legal chain to the given status. */
function advance(
  id: string,
  ...to: Array<"validating" | "uploading" | "building" | "deploying" | "ready">
) {
  for (const status of to) {
    updateDeploymentRecord(id, { status });
  }
}

const LEGAL_TO_DEPLOYING = ["validating", "uploading", "building", "deploying"] as const;
const LEGAL_TO_READY = ["validating", "uploading", "building", "deploying", "ready"] as const;

describe("Deployment persistence and transitions (Step 13)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "acf-deploy-db-"));
    process.env.WORKSPACES_ROOT = tmpRoot;
    process.env.SESSION_SECRET = "test-secret";
    resetDatabase(getDb());
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.WORKSPACES_ROOT;
    delete process.env.MOCK_DEPLOYMENTS;
  });

  it("1. createDeploymentRecord creates a pending record with server-computed fields", () => {
    const project = testWebsiteProject("d1");
    const rec = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "mock",
      artifactHash: "abc123",
    });

    expect(rec.status).toBe("pending");
    expect(rec.providerDeploymentId).toBeNull();
    expect(rec.deploymentUrl).toBeNull();
    expect(rec.failureReason).toBeNull();
    expect(rec.artifactHash).toBe("abc123");
    expect(rec.createdAt).toBeTruthy();
    expect(rec.updatedAt).toBeTruthy();
    expect(listDeploymentRecordsByLead(project.leadId)).toHaveLength(1);
  });

  it("2. client-supplied status/provider/url/id fields are ignored at creation", () => {
    const project = testWebsiteProject("d2");
    const rec = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "vercel",
      artifactHash: "x",
      metadata: { status: "ready", deploymentUrl: "https://evil.test" } as never,
    });

    expect(rec.status).toBe("pending");
    expect(rec.provider).toBe("vercel");
    expect(rec.deploymentUrl).toBeNull();
  });

  it("3. single active deployment per project is enforced (first attempt wins)", () => {
    const project = testWebsiteProject("d3");
    const first = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "vercel",
      artifactHash: "a",
    });

    expect(hasActiveDeploymentForProject(project.projectId)).toBe(true);
    expect(getActiveDeploymentForProject(project.projectId)?.id).toBe(first.id);

    expect(() =>
      createDeploymentRecord({
        websiteProjectId: project.projectId,
        leadId: project.leadId,
        websiteVersionId: project.versionId,
        version: 1,
        provider: "mock",
        artifactHash: "b",
      }),
    ).toThrow(/already active/);
  });

  it("4. two concurrent starts cannot both succeed (DB-level guard)", async () => {
    const project = testWebsiteProject("d4");
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        createDeploymentRecord({
          websiteProjectId: project.projectId,
          leadId: project.leadId,
          websiteVersionId: project.versionId,
          version: 1,
          provider: "vercel",
          artifactHash: "a",
        }),
      ),
      Promise.resolve().then(() =>
        createDeploymentRecord({
          websiteProjectId: project.projectId,
          leadId: project.leadId,
          websiteVersionId: project.versionId,
          version: 1,
          provider: "vercel",
          artifactHash: "b",
        }),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });

  it("5. status transitions are legal and directional", () => {
    const project = testWebsiteProject("d5");
    const rec = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "mock",
      artifactHash: "a",
    });

    for (const status of LEGAL_TO_READY) {
      expect(updateDeploymentRecord(rec.id, { status }).status).toBe(status);
    }
  });

  it("6. backward transitions are rejected even after ready", () => {
    const project = testWebsiteProject("d6");
    const rec = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "mock",
      artifactHash: "a",
    });
    advance(rec.id, ...LEGAL_TO_READY);

    expect(() =>
      updateDeploymentRecord(rec.id, { status: "deploying" }),
    ).toThrow(DeploymentTransitionError);
    expect(() =>
      updateDeploymentRecord(rec.id, { status: "failed" }),
    ).toThrow(DeploymentTransitionError);
  });

  it("7. active -> failed and active -> cancelled are legal; terminal is stable", () => {
    const project = testWebsiteProject("d7");
    const rec = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "mock",
      artifactHash: "a",
    });

    const failed = markDeploymentFailed(rec.id, "auth rejected");
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("auth rejected");

    expect(() => updateDeploymentRecord(rec.id, { status: "uploading" })).toThrow(
      DeploymentTransitionError,
    );
  });

  it("8. once a project's active token is consumed, a new attempt can start", () => {
    const project = testWebsiteProject("d8");
    const first = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "mock",
      artifactHash: "a",
    });
    markDeploymentFailed(first.id, "boom");
    expect(hasActiveDeploymentForProject(project.projectId)).toBe(false);

    const second = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "mock",
      artifactHash: "b",
    });
    expect(second.id).not.toBe(first.id);
    expect(hasActiveDeploymentForProject(project.projectId)).toBe(true);
  });

  it("9. metadata merges (never clobbers existing keys)", () => {
    const project = testWebsiteProject("d9");
    const rec = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "mock",
      artifactHash: "a",
      metadata: { attempt: 1 },
    });

    expect(updateDeploymentRecord(rec.id, { metadata: { provider: "vercel" } }).metadata).toMatchObject(
      { attempt: 1, provider: "vercel" },
    );
  });

  it("10. isActiveDeploymentStatus classifies lifecycle correctly", () => {
    for (const s of ["pending", "validating", "uploading", "building", "deploying"]) {
      expect(isActiveDeploymentStatus(s)).toBe(true);
    }
    for (const s of ["ready", "failed", "cancelled"]) {
      expect(isActiveDeploymentStatus(s)).toBe(false);
    }
    expect(isActiveDeploymentStatus("bogus")).toBe(false);
  });

  it("11. cancellation from active is legal and terminal", () => {
    const project = testWebsiteProject("d11");
    const rec = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "mock",
      artifactHash: "a",
    });
    advance(rec.id, ...LEGAL_TO_DEPLOYING);

    const cancelled = markDeploymentCancelled(rec.id);
    expect(cancelled.status).toBe("cancelled");
    expect(() => updateDeploymentRecord(rec.id, { status: "uploading" })).toThrow(
      DeploymentTransitionError,
    );
  });

  it("12. listDeploymentRecordsByLead orders by recency", async () => {
    const project = testWebsiteProject("d12");
    const first = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "mock",
      artifactHash: "a",
    });
    markDeploymentFailed(first.id, "x");
    await new Promise((r) => setTimeout(r, 5));
    const second = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "mock",
      artifactHash: "b",
    });

    const list = listDeploymentRecordsByLead(project.leadId);
    expect(list.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it("13. active deployment becomes unavailable once ready", () => {
    const project = testWebsiteProject("d13");
    const rec = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "mock",
      artifactHash: "a",
    });
    advance(rec.id, ...LEGAL_TO_READY);
    expect(hasActiveDeploymentForProject(project.projectId)).toBe(false);
    expect(getDeploymentRecord(rec.id)?.deploymentUrl).toBeNull();

    // Mark a URL to ensure we can query it.
    updateDeploymentRecord(rec.id, { deploymentUrl: "https://a.example.test" });
    expect(getDeploymentRecord(rec.id)?.deploymentUrl).toBe("https://a.example.test");
  });

  it("14. providerDeploymentId and jobId can be recorded during a run", () => {
    const project = testWebsiteProject("d14");
    const rec = createDeploymentRecord({
      websiteProjectId: project.projectId,
      leadId: project.leadId,
      websiteVersionId: project.versionId,
      version: 1,
      provider: "mock",
      artifactHash: "a",
      jobId: "job-1",
    });
    const updated = updateDeploymentRecord(rec.id, {
      status: "uploading",
      providerDeploymentId: "mock_abc",
    });
    expect(updated.jobId).toBe("job-1");
    expect(updated.providerDeploymentId).toBe("mock_abc");
  });
});