import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/data/db";
import { resetDatabase } from "@/lib/data/schema";
import {
  countWebsiteVersions,
  createWebsiteVersion,
  getLatestWebsiteVersion,
  listWebsiteVersions,
} from "@/lib/data/websites";
import { JobController, JobStoppedError } from "@/lib/jobs/controller";
import { runWebsiteGeneration } from "@/lib/jobs/website-flow";
import { upsertLeadFromDiscovery } from "@/lib/data/leads";
import { makeLead, makeProject, makeResearch } from "./helpers";

vi.mock("@/lib/website-builder", () => ({
  generateWebsite: async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    (globalThis as { __stopAfterGeneration?: () => void }).__stopAfterGeneration?.();
    return {
      status: "completed",
      project: makeProject({ projectId: "site_mock" }),
      errorMessage: null,
    };
  },
}));

beforeEach(() => {
  resetDatabase(getDb());
});

describe("website version integrity", () => {
  it("creates sequential versions and keeps only one current version", () => {
    const v1 = createWebsiteVersion("lead-1", makeProject({ projectId: "p-1" }));
    const v2 = createWebsiteVersion("lead-1", makeProject({ projectId: "p-2" }));

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(countWebsiteVersions("lead-1")).toBe(2);

    const versions = listWebsiteVersions("lead-1");
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions.find((v) => v.version === 1)?.isCurrent).toBe(false);
    expect(versions.find((v) => v.version === 2)?.isCurrent).toBe(true);
    expect(getLatestWebsiteVersion("lead-1")?.version).toBe(2);
  });

  it("enforces a unique (lead_id, version) constraint in the database", () => {
    createWebsiteVersion("lead-1", makeProject({ projectId: "p-1" }));

    const direct = getDb().prepare(
      `INSERT INTO website_versions (id, lead_id, version, status, website_project_json, is_current, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', ?, 0, ?, ?)`,
    );
    const now = new Date().toISOString();
    expect(() =>
      direct.run("dup", "lead-1", 1, JSON.stringify(makeProject({ projectId: "dup" })), now, now),
    ).toThrow(/UNIQUE/i);
  });
});

describe("website generation stop control", () => {
  it("throws before persistence when stopped before generation starts", async () => {
    const lead = upsertLeadFromDiscovery(makeLead("place-stop-before")).lead;
    const controller = new JobController("job-stop-before");
    controller.requestStop();

    await expect(
      runWebsiteGeneration({
        leadId: lead.id,
        lead: makeLead("place-stop-before"),
        contact: null,
        research: makeResearch(),
        controller,
      }),
    ).rejects.toBeInstanceOf(JobStoppedError);

    expect(countWebsiteVersions(lead.id)).toBe(0);
  });

  it("persists nothing when stopped after generation but before the version row", async () => {
    const lead = upsertLeadFromDiscovery(makeLead("place-stop-after")).lead;
    const controller = new JobController("job-stop-after");
    (globalThis as { __stopAfterGeneration?: () => void }).__stopAfterGeneration = () => {
      controller.requestStop();
    };

    await expect(
      runWebsiteGeneration({
        leadId: lead.id,
        lead: makeLead("place-stop-after"),
        contact: null,
        research: makeResearch(),
        controller,
      }),
    ).rejects.toBeInstanceOf(JobStoppedError);

    expect(countWebsiteVersions(lead.id)).toBe(0);
  });
});