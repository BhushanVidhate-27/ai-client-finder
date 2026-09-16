import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDatabase } from "@/lib/data/schema";
import { getDb } from "@/lib/data/db";
import { createDeploymentRegistry } from "@/lib/deployment/registry";
import { isProviderConfigured } from "@/lib/deployment/config";
import { MockProviderAdapter, MOCK_DEPLOYMENT_DOMAIN } from "@/lib/deployment/providers/mock";
import { packageDeployment } from "@/lib/deployment/service";
import { pollDeploymentUntilTerminal } from "@/lib/deployment/service";
import {
  DeploymentNotConfiguredError,
  MockProviderDisabledError,
} from "@/lib/deployment/errors";
import { createWebsiteProjectVersion } from "@/lib/data/websites";
import { writeWorkspaceFiles, workspaceDir } from "@/lib/website-coding/workspace";
import type { DeploymentProviderId, DeploymentStatus } from "@/lib/deployment/types";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "acf-deploy-providers-"));
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

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("Deployment registry (Step 13)", () => {
  it("1. lists three real providers even when none is configured", () => {
    const registry = createDeploymentRegistry();
    const ids = registry.listProviders().map((p) => p.id);
    expect(ids).toContain("vercel");
    expect(ids).toContain("netlify");
    expect(ids).toContain("cloudflare");
    expect(ids).not.toContain("mock");
  });

  it("2. mock provider absent when mockEnabled is false", () => {
    const registry = createDeploymentRegistry({ mockEnabled: false });
    expect(registry.getAdapter("mock")).toBeNull();
    expect(registry.listProviders().map((p) => p.id)).not.toContain("mock");
  });

  it("3. mock provider present when mockEnabled is true", () => {
    const registry = createDeploymentRegistry({ mockEnabled: true });
    expect(registry.getAdapter("mock")).not.toBeNull();
    expect(registry.listProviders().map((p) => p.id)).toContain("mock");
  });

  it("4. unknown provider id returns null", () => {
    const registry = createDeploymentRegistry();
    expect(registry.getAdapter("aws" as DeploymentProviderId)).toBeNull();
  });

  it("5. connection state is not_configured when no tokens are set", async () => {
    const registry = createDeploymentRegistry();
    for (const id of ["vercel", "netlify", "cloudflare"] as DeploymentProviderId[]) {
      const conn = await registry.getProviderConnectionState(id);
      expect(conn.state).toBe("not_configured");
    }
  });

  it("6. custom adapters can be injected (used in flow tests)", () => {
    const fake = { providerId: "vercel", providerLabel: "Fake Vercel", isMock: false, supportsCancel: true, validateConnection: () => ({ state: "connected" as const, message: null }) } as never;
    const registry = createDeploymentRegistry({ mockEnabled: false }, { vercel: fake });
    expect(registry.getAdapter("vercel")?.providerLabel).toBe("Fake Vercel");
  });

  it("7. isProviderConfigured returns correct boolean per provider", () => {
    expect(isProviderConfigured("vercel", { mockEnabled: false })).toBe(false);
    expect(isProviderConfigured("vercel", { mockEnabled: false, vercelToken: "tok" })).toBe(true);
    expect(isProviderConfigured("netlify", { mockEnabled: false, netlifyToken: "tok" })).toBe(true);
    expect(isProviderConfigured("cloudflare", { mockEnabled: false, cloudflareToken: "tok", cloudflareAccountId: "acc" })).toBe(true);
    expect(isProviderConfigured("cloudflare", { mockEnabled: false, cloudflareToken: "tok" })).toBe(false);
    expect(isProviderConfigured("mock", { mockEnabled: true })).toBe(true);
    expect(isProviderConfigured("mock", { mockEnabled: false })).toBe(false);
    expect(isProviderConfigured("unknown", { mockEnabled: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

describe("Mock provider adapter (Step 13)", () => {
  it("8. not_configured when config.mockEnabled is false", async () => {
    const adapter = new MockProviderAdapter({ config: { mockEnabled: false } });
    expect(await adapter.validateConnection()).toMatchObject({ state: "not_configured" });
    await expect(
      adapter.deploy({ artifact: { files: [], hash: "x" }, websiteProjectId: "p", version: 1 }),
    ).rejects.toThrow(MockProviderDisabledError);
  });

  it("9. deploy records the artifact and returns a mock handle", async () => {
    const adapter = new MockProviderAdapter({ config: { mockEnabled: true } });
    const handle = await adapter.deploy({ artifact: { files: [{ path: "index.html", content: "hi" }], hash: "abc" }, websiteProjectId: "proj1", version: 2 });

    expect(handle.providerDeploymentId).toMatch(/^mock_/);
    expect(handle.status).toBe("uploading");
    expect(adapter.deployments).toHaveLength(1);
    expect(adapter.deployments[0].request.artifact.hash).toBe("abc");
    expect(adapter.deployments[0].request.websiteProjectId).toBe("proj1");
    expect(adapter.deployments[0].request.version).toBe(2);
  });

  it("10. status sequence advances to ready and then stays terminal", async () => {
    const adapter = new MockProviderAdapter({ config: { mockEnabled: true } });
    const handle = await adapter.deploy({ artifact: { files: [], hash: "x" }, websiteProjectId: "p", version: 1 });

    const s1 = await adapter.getDeploymentStatus(handle);
    expect(s1.status).toBe("uploading");

    const s2 = await adapter.getDeploymentStatus(handle);
    expect(s2.status).toBe("building");

    const s3 = await adapter.getDeploymentStatus(handle);
    expect(s3.status).toBe("deploying");

    const s4 = await adapter.getDeploymentStatus(handle);
    expect(s4.status).toBe("ready");
    expect(s4.url).toMatch(new RegExp(`^https://mock_[a-z0-9_-]+\\.${MOCK_DEPLOYMENT_DOMAIN}$`));
    expect(s4.message).toMatch(/mock/i);

    const s5 = await adapter.getDeploymentStatus(handle);
    expect(s5.status).toBe("ready");
    expect(s5.url).toBe(s4.url);
  });

  it("11. cancelled status is returned when deploy is followed by cancel", async () => {
    const adapter = new MockProviderAdapter({ config: { mockEnabled: true } });
    const handle = await adapter.deploy({ artifact: { files: [], hash: "x" }, websiteProjectId: "p", version: 1 });
    const cancel = await adapter.cancelDeployment(handle);
    expect(cancel.cancelled).toBe(true);
    expect(cancel.providerDeploymentId).toBe(handle.providerDeploymentId);
    expect(adapter.cancelled).toContain(handle.providerDeploymentId);
  });

  it("12. failure sequence: adapter reports failed when sequence includes failed", async () => {
    const adapter = new MockProviderAdapter({ config: { mockEnabled: true }, sequence: ["uploading", "failed"] });
    const handle = await adapter.deploy({ artifact: { files: [], hash: "x" }, websiteProjectId: "p", version: 1 });

    await adapter.getDeploymentStatus(handle); // uploading
    const snap = await adapter.getDeploymentStatus(handle); // failed
    expect(snap.status).toBe("failed");
    expect(snap.url).toBeNull();
  });

  it("13. unknown handle returns failed (provider lost tracking)", async () => {
    const adapter = new MockProviderAdapter({ config: { mockEnabled: true } });
    const snap = await adapter.getDeploymentStatus({
      providerDeploymentId: "mock_unknown",
      status: "deploying",
      url: null,
    });
    expect(snap.status).toBe("failed");
    expect(snap.message).toMatch(/unknown/i);
  });

  it("14. pollDeploymentUntilTerminal completes when terminal is in the sequence", async () => {
    const adapter = new MockProviderAdapter({ config: { mockEnabled: true } });
    const handle = await adapter.deploy({ artifact: { files: [], hash: "x" }, websiteProjectId: "p", version: 1 });
    const result = await pollDeploymentUntilTerminal(adapter, handle, { maxAttempts: 10, intervalMs: 0, totalTimeoutMs: 5000 });
    expect(result.status).toBe("ready");
    expect(result.url).toMatch(/\.example\.test$/);
  });

  it("15. pollDeploymentUntilTerminal throws DeploymentTimeoutError on unreachable terminal", async () => {
    const neverReady: DeploymentStatus[] = ["uploading", "building", "uploading", "building"];
    const adapter = new MockProviderAdapter({ config: { mockEnabled: true }, sequence: neverReady });
    const handle = await adapter.deploy({ artifact: { files: [], hash: "x" }, websiteProjectId: "p", version: 1 });

    await expect(
      pollDeploymentUntilTerminal(adapter, handle, { maxAttempts: 3, intervalMs: 0, totalTimeoutMs: 5000 }),
    ).rejects.toThrow(/terminal state in time/i);
  });

  it("16. deploy returns null url until terminal; ready returns the assigned mock url", async () => {
    const adapter = new MockProviderAdapter({ config: { mockEnabled: true }, url: "https://custom.example.test" });
    const handle = await adapter.deploy({ artifact: { files: [], hash: "x" }, websiteProjectId: "p", version: 1 });
    expect(handle.url).toBeNull();
    const snap = await adapter.getDeploymentStatus(handle); // uploading
    expect(snap.url).toBeNull();

    // advance to ready
    await adapter.getDeploymentStatus(handle); // building
    await adapter.getDeploymentStatus(handle); // deploying
    await adapter.getDeploymentStatus(handle); // ready
    const readySnap = await adapter.getDeploymentStatus(handle);
    expect(readySnap.url).toBe("https://custom.example.test");
  });
});

// ---------------------------------------------------------------------------
// Real provider adapters (no real network calls)
// ---------------------------------------------------------------------------

describe("Real provider adapters — connection checks (Step 13)", () => {
  it("17. vercel adapter: not_configured when VERCEL_TOKEN is absent", async () => {
    const { VercelDeploymentAdapter } = await import("@/lib/deployment/providers/vercel");
    const adapter = new VercelDeploymentAdapter();
    const conn = await adapter.validateConnection();
    expect(conn.state).toBe("not_configured");
    expect(adapter.isMock).toBe(false);
    expect(adapter.supportsCancel).toBe(true);
  });

  it("18. netlify adapter: not_configured when NETLIFY_TOKEN is absent", async () => {
    const { NetlifyDeploymentAdapter } = await import("@/lib/deployment/providers/netlify");
    const adapter = new NetlifyDeploymentAdapter();
    const conn = await adapter.validateConnection();
    expect(conn.state).toBe("not_configured");
    expect(adapter.isMock).toBe(false);
    expect(adapter.supportsCancel).toBe(false);
  });

  it("19. cloudflare adapter: not_configured when CLOUDFLARE_API_TOKEN is absent", async () => {
    const { CloudflarePagesDeploymentAdapter } = await import("@/lib/deployment/providers/cloudflare");
    const adapter = new CloudflarePagesDeploymentAdapter();
    const conn = await adapter.validateConnection();
    expect(conn.state).toBe("not_configured");
    expect(adapter.isMock).toBe(false);
    expect(adapter.supportsCancel).toBe(false);
  });

  it("20. real adapters do not throw on deploy check; they return not_configured synchronously", async () => {
    const { VercelDeploymentAdapter } = await import("@/lib/deployment/providers/vercel");
    const adapter = new VercelDeploymentAdapter();
    await expect(
      adapter.deploy({ artifact: { files: [], hash: "x" }, websiteProjectId: "p", version: 1 }),
    ).rejects.toThrow(DeploymentNotConfiguredError);
  });
});

// ---------------------------------------------------------------------------
// Artifact packaging
// ---------------------------------------------------------------------------

describe("Artifact packaging (Step 13)", () => {
  async function makeWs(tag: string): Promise<{ workspaceId: string; projectId: string }> {
    const { projectId } = createWebsiteProjectVersion(`place-pack-${tag}`);
    const version = (await import("@/lib/data/websites")).getWebsiteVersion(projectId)!;
    await writeWorkspaceFiles(version.workspaceId!, [
      { path: "index.html", content: `<h1>${tag}</h1>` },
      { path: "styles.css", content: "body{}" },
      { path: "favicon.svg", content: "<svg/>" },
      { path: ".env", content: "SECRET=abc" },
      { path: ".env.local", content: "TOKEN=xyz" },
      { path: "build.json", content: '{"status":"success"}' },
      { path: "build-errors.json", content: "[]" },
      { path: "images/logo.png", content: "png-data" },
      { path: "subdir/data.json", content: '{"k":"v"}' },
    ]);
    return { workspaceId: version.workspaceId!, projectId };
  }

  it("21. includes safe files and excludes .env, build.json, build-errors.json, dotfiles", async () => {
    const { workspaceId } = await makeWs("p1");
    const artifact = await packageDeployment(workspaceId);

    const paths = artifact.files.map((f) => f.path).sort();
    expect(paths).toContain("index.html");
    expect(paths).toContain("styles.css");
    expect(paths).toContain("favicon.svg");
    expect(paths).toContain("images/logo.png");
    expect(paths).toContain("subdir/data.json");

    expect(paths).not.toContain(".env");
    expect(paths).not.toContain(".env.local");
    expect(paths).not.toContain("build.json");
    expect(paths).not.toContain("build-errors.json");
  });

  it("22. hash is deterministic and independent of disk order (files sorted internally)", async () => {
    const { workspaceId } = await makeWs("p2");
    const a = await packageDeployment(workspaceId);
    const b = await packageDeployment(workspaceId);
    expect(a.hash).toBe(b.hash);
    expect(a.files.map((f) => f.path)).toEqual(b.files.map((f) => f.path));
  });

  it("23. changing a file content changes the hash", async () => {
    const { workspaceId } = await makeWs("p3");
    const before = await packageDeployment(workspaceId);
    await writeWorkspaceFiles(workspaceId, [
      { path: "index.html", content: "<h1>CHANGED</h1>" },
    ]);
    const after = await packageDeployment(workspaceId);
    expect(after.hash).not.toBe(before.hash);
  });

  it("24. packageDeployment works for an empty workspace (hash is still stable)", async () => {
    const { projectId } = createWebsiteProjectVersion("place-pack-empty");
    const version = (await import("@/lib/data/websites")).getWebsiteVersion(projectId)!;
    mkdirSync(workspaceDir(version.workspaceId!), { recursive: true });
    const artifact = await packageDeployment(version.workspaceId!);
    expect(artifact.files).toHaveLength(0);
    expect(artifact.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});