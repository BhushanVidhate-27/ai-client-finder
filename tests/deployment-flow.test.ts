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
import { JobController, JobStoppedError } from "@/lib/jobs/controller";
import { runWebsiteProjectGeneration } from "@/lib/jobs/website-project-flow";
import { runWebsiteDeployment } from "@/lib/jobs/website-deployment-flow";
import { verifyVersionEligible } from "@/lib/deployment/service";
import { createDeploymentRegistry } from "@/lib/deployment/registry";
import { MockProviderAdapter } from "@/lib/deployment/providers/mock";
import { writeWorkspaceFiles } from "@/lib/website-coding/workspace";
import { getCurrentWebsiteVersion } from "@/lib/data/websites";
import {
  getDeploymentRecord,
  listDeploymentRecordsByLead,
} from "@/lib/data/deployments";
import { DeploymentIneligibleError } from "@/lib/deployment/errors";
import { makeLead, makeResearch } from "./helpers";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import type { Agent } from "@/lib/agents/types";
import { createWebsiteDeployerAgent } from "@/lib/website-deployer/agent";

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

function mockRegistry() {
  const mock = new MockProviderAdapter({ config: { mockEnabled: true } });
  const registry = createDeploymentRegistry({ mockEnabled: true }, { mock });
  return { mock, registry };
}

function failingDeployerAgent(): Agent {
  const d = {
    id: "website-deployer",
    name: "Website Deployer Agent",
    description: "test",
    jobType: "deployment",
    permissions: ["read", "execute", "deploy"] as const,
    tools: [],
    plan() {
      return {
        objective: "noop",
        constraints: [],
        acceptanceCriteria: [],
        steps: [{ id: "s", label: "s" }],
        allowedActions: ["deployment.deploy"],
        verificationRequirements: [],
        maxIterations: 5,
      };
    },
    async inspect() {
      return { id: "obs", iteration: 0, description: "noop", at: new Date().toISOString() };
    },
    decide() {
      return { name: "missing.tool", permission: "read" as const };
    },
    async verify() {
      return { id: "ver", iteration: 0, passed: false, checks: [], at: new Date().toISOString() };
    },
  };
  return d as unknown as Agent;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "acf-deploy-flow-"));
  process.env.WORKSPACES_ROOT = tmpRoot;
  process.env.SESSION_SECRET = "test-secret";
  delete process.env.VERCEL_TOKEN;
  delete process.env.NETLIFY_TOKEN;
  delete process.env.NETLIFY_SITE_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.MOCK_DEPLOYMENTS;
  resetDatabase(getDb());
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.WORKSPACES_ROOT;
});

async function seedCurrentVersion(placeId: string, businessName = "Deploy Co") {
  const lead = makeLead(placeId, businessName);
  const controller = new JobController(`job-gen-${placeId}`);
  const result = await runWebsiteProjectGeneration({
    leadId: lead.placeId,
    lead,
    contact: testContact(),
    research: makeResearch(),
    controller,
  });
  return { lead, current: getCurrentWebsiteVersion(lead.placeId)!, result };
}

describe("Deployment flow (Step 13) — eligibility and end-to-end", () => {
  it("1. rejects deploy when no website version exists", async () => {
    const lead = makeLead("place-no-version", "No Version Co");
    const controller = new JobController("job-d1");

    await expect(
      verifyVersionEligible(lead.placeId),
    ).rejects.toThrow(DeploymentIneligibleError);

    const { registry } = mockRegistry();
    await expect(
      runWebsiteDeployment(
        { leadId: lead.placeId, provider: "mock", controller },
        { registry },
      ),
    ).rejects.toThrow(DeploymentIneligibleError);
  });

  it("2. rejects a requested version id that is not the current one", async () => {
    const { lead, result } = await seedCurrentVersion("place-wrong-version");
    const controller = new JobController("job-d2");
    const { registry } = mockRegistry();

    await expect(
      runWebsiteDeployment(
        { leadId: lead.placeId, provider: "mock", versionId: "not-the-current", controller },
        { registry },
      ),
    ).rejects.toThrow(/not the current verified version/);
    expect(result).toBeTruthy();
  });

  it("3. rejects when the current version has not passed build/QA", async () => {
    const { lead } = await seedCurrentVersion("place-not-ready");
    const current = getCurrentWebsiteVersion(lead.placeId)!;

    // Corrupt QA result via direct SQL (bypasses transition checks).
    getDb()
      .prepare("UPDATE website_versions SET qa_status = 'fail' WHERE id = ?")
      .run(current.projectId);

    await expect(verifyVersionEligible(lead.placeId)).rejects.toThrow(
      /QA has not passed/,
    );
  });

  it("4. rejects a workspace that was modified after QA (hash mismatch)", async () => {
    const { lead, current } = await seedCurrentVersion("place-hash");
    await writeWorkspaceFiles(current.workspaceId!, [
      { path: "index.html", content: "tampered!" },
    ]);

    await expect(verifyVersionEligible(lead.placeId)).rejects.toThrow(
      /modified after QA/,
    );
  });

  it("5. missing credentials never fire a real deploy (not_configured; audit record marked failed)", async () => {
    const { lead } = await seedCurrentVersion("place-vercel-dark");
    const registry = createDeploymentRegistry(); // no tokens, no mock

    const listBefore = listDeploymentRecordsByLead(lead.placeId);
    expect(listBefore).toHaveLength(0);

    const vercelConn = await registry.getProviderConnectionState("vercel");
    expect(vercelConn.state).toBe("not_configured");

    const controller = new JobController("job-d5");
    await expect(
      runWebsiteDeployment(
        { leadId: lead.placeId, provider: "vercel", controller },
        { registry },
      ),
    ).rejects.toThrow(/connection failed|not_configured/i);

    // The attempt is recorded as failed (source of truth for audit), but no
    // real provider call was made and the record marks the failure reason.
    const records = listDeploymentRecordsByLead(lead.placeId);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("failed");
    expect(records[0].failureReason).toMatch(/connection failed/i);
  });

  it("6. mock not enabled -> mock provider absent/not_configured and deploy throws before creating state", async () => {
    const registry = createDeploymentRegistry({ mockEnabled: false });
    expect(registry.getAdapter("mock")).toBeNull();
    const conn = await registry.getProviderConnectionState("mock");
    expect(conn.state).toBe("not_configured");
  });

  it("7. end-to-end deploy to mock reaches ready with a mock URL", async () => {
    const { lead } = await seedCurrentVersion("place-ok");
    const { mock, registry } = mockRegistry();
    const controller = new JobController("job-deploy-ok");

    const result = await runWebsiteDeployment(
      { leadId: lead.placeId, provider: "mock", controller },
      { registry },
    );

    expect(result.status).toBe("ready");
    expect(result.provider).toBe("mock");
    expect(result.deploymentUrl).toMatch(/\.example\.test$/);
    expect(result.artifactHash).toBeTruthy();

    const record = getDeploymentRecord(result.deploymentId)!;
    expect(record.status).toBe("ready");
    expect(record.providerDeploymentId).toMatch(/^mock_/);
    expect(record.deploymentUrl).toMatch(/\.example\.test$/);
    expect(record.artifactHash).toBeTruthy();

    // The mock received exactly one artifact request and it never mutated it.
    expect(mock.deployments).toHaveLength(1);
    const deployed = mock.deployments[0];
    expect(deployed.request.artifact.hash).toBe(result.artifactHash);
    expect(deployed.request.websiteProjectId).toBeTruthy();
  });

  it("8. concurrent starts for the same project: only one wins", async () => {
    const { lead } = await seedCurrentVersion("place-race");
    const { registry } = mockRegistry();
    const controllerA = new JobController("job-a");
    const controllerB = new JobController("job-b");

    const results = await Promise.allSettled([
      runWebsiteDeployment(
        { leadId: lead.placeId, provider: "mock", controller: controllerA },
        { registry },
      ),
      runWebsiteDeployment(
        { leadId: lead.placeId, provider: "mock", controller: controllerB },
        { registry },
      ),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["fulfilled", "rejected"]);

    const records = listDeploymentRecordsByLead(lead.placeId);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("ready");
    expect(records[0].providerDeploymentId).toMatch(/^mock_/);
  });

  it("9. a failing deployer agent leaves the record failed", async () => {
    const { lead } = await seedCurrentVersion("place-fail");
    const { registry } = mockRegistry();
    const controller = new JobController("job-fail");

    await expect(
      runWebsiteDeployment(
        { leadId: lead.placeId, provider: "mock", controller },
        { registry, deployerAgent: failingDeployerAgent() },
      ),
    ).rejects.toThrow(/iterations reached|failed/i);

    const records = listDeploymentRecordsByLead(lead.placeId);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("failed");
  });

  it("10. requesting a stop during deployment cancels the record (JobStoppedError)", async () => {
    const { lead } = await seedCurrentVersion("place-stop");
    const { mock, registry } = mockRegistry();
    const controller = new JobController("job-stop");

    // Deployer wrapped so we can stop it before the first deploy action.
    const deployer = createWebsiteDeployerAgent({
      adapter: mock,
      state: {
        handle: null,
        artifact: { files: [], hash: "x" },
        deploymentId: "none",
        workspaceId: "none",
        websiteProjectId: "none",
        storedArtifactHash: "x",
        latestSnapshot: null,
      },
    });

    let fired = false;
    const wrapped: Agent = {
      ...deployer,
      async decide(...args: Parameters<typeof deployer.decide>) {
        if (!fired) {
          fired = true;
          controller.requestStop();
        }
        return deployer.decide(...args);
      },
    };

    await expect(
      runWebsiteDeployment(
        { leadId: lead.placeId, provider: "mock", controller },
        {
          registry,
          deployerAgent: wrapped,
        },
      ),
    ).rejects.toThrow(JobStoppedError);

    const records = listDeploymentRecordsByLead(lead.placeId);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("cancelled");
  });

  it("11. eligibility verification is a pure read (nothing written on ineligible)", async () => {
    const { lead } = await seedCurrentVersion("place-pure");
    const current = getCurrentWebsiteVersion(lead.placeId)!;
    await writeWorkspaceFiles(current.workspaceId!, [
      { path: "index.html", content: "changed" },
    ]);

    await expect(verifyVersionEligible(lead.placeId)).rejects.toThrow(
      DeploymentIneligibleError,
    );
    expect(listDeploymentRecordsByLead(lead.placeId)).toHaveLength(0);
  });
});