import {
  afterEach,
  beforeAll,
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
import {
  createCampaign,
  linkCampaignLead,
  getCampaign,
} from "@/lib/data/campaigns";
import {
  setLeadPrimaryCampaign,
  updateLeadContactDiscovery,
  updateLeadQualificationData,
  upsertLeadFromDiscovery,
} from "@/lib/data/leads";
import { upsertResearch } from "@/lib/data/research";
import {
  createWebsiteProjectVersion,
  getCurrentWebsiteVersion,
  getLatestWebsiteVersion,
  listWebsiteVersions,
  promoteWebsiteVersion,
  updateWebsiteVersionResult,
} from "@/lib/data/websites";
import {
  createDeploymentRecord,
  listDeploymentRecordsByLead,
  markDeploymentFailed,
  updateDeploymentRecord,
} from "@/lib/data/deployments";
import {
  createOutreachApproval,
  createOutreachDraft,
  getOutreachDraft,
  listOutreachDraftsByLead,
  listOutreachSendsByLead,
  recordOutreachOptOut,
} from "@/lib/data/outreach";
import { createDeploymentApproval } from "@/lib/data/deployment-approvals";
import { createJob, tryTransitionJobStatus } from "@/lib/data/jobs";
import { runJob, JobStopped } from "@/lib/jobs/run-job";
import {
  runCampaignExecution,
  getCampaignExecutionSummary,
} from "@/lib/campaign-execution/runner";
import type {
  CampaignExecutionServices,
  DiscoverLeadsFn,
  QualifyLeadsFn,
} from "@/lib/campaign-execution/types";
import { createSessionToken } from "@/lib/auth/session";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { seedDefaultAgents } from "@/lib/agents/registry";
import { createDeploymentRegistry } from "@/lib/deployment/registry";
import { MockProviderAdapter } from "@/lib/deployment/providers/mock";
import { evaluateNextAction } from "@/lib/campaign-orchestrator/evaluate";
import { normalizeRecipientEmail } from "@/lib/outreach-safety/safety";
import { makeLead, makeQualification, makeResearch } from "./helpers";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import type { WebsiteResearch } from "@/lib/lead-research";
import type { ResearchResult } from "@/lib/lead-research";
import type { LeadQualification } from "@/lib/lead-qualification";
import type { CampaignExecutionSummary } from "@/lib/campaign-execution/types";

import { POST as executeRoute } from "@/app/api/campaigns/[campaignId]/execute/route";
import { GET as executionRoute } from "@/app/api/campaigns/[campaignId]/execution/route";
import { POST as stopRoute } from "@/app/api/campaigns/[campaignId]/stop/route";
import { POST as pauseRoute } from "@/app/api/campaigns/[campaignId]/pause/route";
import { POST as resumeRoute } from "@/app/api/campaigns/[campaignId]/resume/route";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTACT_EMAIL = "office@acme.test";
const SAFE_SUBJECT = "Quick intro";
const SAFE_BODY =
  "Hello! We design modern marketing websites that improve online visibility. " +
  "Would you be open to a quick conversation about how we could help improve your site?";
const LIVE_URL = "https://live.acme-site.com";

let sequence = 0;
let tmpRoot: string;

beforeAll(() => {
  sequence += 1;
  seedDefaultAgents();
});

beforeEach(() => {
  sequence += 1;
  resetDatabase(getDb());
  tmpRoot = mkdtempSync(path.join(tmpdir(), "acf-exec-"));
  process.env.WORKSPACES_ROOT = tmpRoot;
  process.env.SESSION_SECRET = "test-secret";
  delete process.env.EMAIL_TRANSPORT_CONFIGURED;
  delete process.env.MOCK_DEPLOYMENTS;
});

afterEach(() => {
  delete process.env.EMAIL_TRANSPORT_CONFIGURED;
  delete process.env.MOCK_DEPLOYMENTS;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function makePlaceId(label: string): string {
  return `exec-${process.pid}-${sequence}-${label}`;
}

function verifiedContact(email = CONTACT_EMAIL): ContactDiscovery {
  return {
    email,
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

function emailNotFoundContact(): ContactDiscovery {
  return {
    email: null,
    emailType: null,
    emailSourceUrl: null,
    emailConfidence: null,
    emailStatus: "not_found",
    phone: "+1 555 0100",
    phoneSourceUrl: null,
    contactMethod: "none",
    discoveryPath: "no_website",
  };
}

function websiteQualification(
  websiteOpportunity: "NO_WEBSITE" | "NEEDS_REDESIGN" | "GOOD_WEBSITE" | "UNKNOWN",
  qualified = true,
): LeadQualification {
  return {
    ...makeQualification(),
    qualified,
    qualificationStatus: "complete",
    websiteOpportunity,
  };
}

function seedProspect(
  placeId: string,
  opts?: {
    websiteOpportunity?: "NO_WEBSITE" | "NEEDS_REDESIGN" | "GOOD_WEBSITE" | "UNKNOWN";
    qualified?: boolean;
    research?: WebsiteResearch | null;
    contact?: ContactDiscovery | null;
    campaignStatus?: string;
  },
) {
  const leadSource = makeLead(placeId, `${placeId} biz`);
  const { lead } = upsertLeadFromDiscovery(leadSource);
  updateLeadQualificationData(
    lead.id,
    websiteQualification(opts?.websiteOpportunity ?? "NO_WEBSITE", opts?.qualified ?? true),
  );
  updateLeadContactDiscovery(
    lead.id,
    opts?.contact !== undefined ? (opts.contact ?? emailNotFoundContact()) : verifiedContact(),
  );
  const campaign = createCampaign({
    niche: "Plumbing",
    location: "Nowhere",
    requestedLeadCount: 5,
    status: opts?.campaignStatus ?? "running",
  });
  linkCampaignLead(campaign.id, lead.id);
  setLeadPrimaryCampaign(lead.id, campaign.id);
  if (opts?.research === undefined) {
    upsertResearch(lead.id, makeResearch());
  } else if (opts.research !== null) {
    upsertResearch(lead.id, opts.research);
  }
  return { lead, campaign };
}

function seedVersionReadyAndCurrent(
  leadId: string,
  opts?: { artifactHash?: string; promote?: boolean },
) {
  const version = createWebsiteProjectVersion(leadId);
  updateWebsiteVersionResult(version.projectId, { status: "building", buildStatus: "building" });
  updateWebsiteVersionResult(version.projectId, { status: "qa", qaStatus: "qa" });
  updateWebsiteVersionResult(version.projectId, {
    status: "ready",
    buildStatus: "success",
    qaStatus: "pass",
    artifactHash: opts?.artifactHash ?? "artifact-x",
  });
  if (opts?.promote !== false) promoteWebsiteVersion(version.projectId);
  return version;
}

function seedDeploymentApprovalForVersion(
  leadId: string,
  versionId: string,
  artifactHash = "artifact-x",
  opts?: { expiresAt?: string | null; createdBy?: string | null },
) {
  return createDeploymentApproval({
    leadId,
    websiteVersionId: versionId,
    artifactHash,
    createdBy: opts?.createdBy ?? "user-1",
    expiresAt: opts?.expiresAt ?? null,
  });
}

/** Seeds a version + a ready deployment record directly (no flow). */
function seedDeployedLiveSite(leadId: string, url: string) {
  const version = seedVersionReadyAndCurrent(leadId);
  let deployment = createDeploymentRecord({
    websiteProjectId: version.websiteProjectId!,
    leadId,
    websiteVersionId: version.projectId,
    version: version.version,
    provider: "mock",
    artifactHash: version.artifactHash ?? "artifact-x",
  });
  for (const status of ["validating", "uploading", "building", "deploying"]) {
    deployment = updateDeploymentRecord(deployment.id, { status: status as never });
  }
  deployment = updateDeploymentRecord(deployment.id, { status: "ready", deploymentUrl: url });
  seedDeploymentApprovalForVersion(leadId, version.projectId, version.artifactHash ?? "artifact-x");
  return { version, deployment };
}

function seedDraft(
  leadId: string,
  overrides?: {
    status?: "pending_review" | "eligible" | "blocked";
    websiteVersionId?: string | null;
    websiteUrl?: string | null;
    subject?: string | null;
    body?: string;
  },
) {
  return createOutreachDraft({
    leadId,
    subject: overrides?.subject ?? SAFE_SUBJECT,
    body: overrides?.body ?? SAFE_BODY,
    status: overrides?.status ?? "eligible",
    websiteVersionId: overrides?.websiteVersionId ?? null,
    websiteUrl: overrides?.websiteUrl ?? null,
  });
}

function seedOutreachApproval(leadId: string, draftId: string, recipientEmail: string) {
  const draft = getOutreachDraft(draftId)!;
  return createOutreachApproval({
    leadId,
    draftId,
    recipientEmail: normalizeRecipientEmail(recipientEmail),
    draftHash: draft.contentHash,
    createdBy: "user-1",
  });
}

// ---------------------------------------------------------------------------
// Runner harness
// ---------------------------------------------------------------------------

function mockRegistry(opts?: { url?: string }) {
  const mock = new MockProviderAdapter({
    config: { mockEnabled: true },
    // A public-looking URL so the runner's live-site-claim draft passes the
    // deterministic content-safety scan (the reserved *.example.test domain is
    // blocked by url-safety on purpose).
    url: opts?.url ?? "https://site.example.com",
  });
  const registry = createDeploymentRegistry({ mockEnabled: true }, { mock });
  return { mock, registry };
}

async function runExecution(
  campaignId: string,
  services: CampaignExecutionServices = {},
) {
  return runJob(
    { type: "campaign_orchestration", campaignId, metadata: {} },
    (controller) => runCampaignExecution(campaignId, { controller, services }),
  );
}

function completeResearch(placeId: string): ResearchResult {
  return {
    placeId,
    status: "complete",
    websiteResearch: makeResearch(),
    errorMessage: null,
  };
}

function failingResearch(placeId: string): ResearchResult {
  return {
    placeId,
    status: "failed",
    websiteResearch: null,
    errorMessage: "Research is temporarily unavailable.",
  };
}

const completeResearchForAll: CampaignExecutionServices["researchLeads"] = async (leads) =>
  leads.map((l) => completeResearch(l.placeId));

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function adminToken(): Promise<string> {
  return createSessionToken("admin");
}

function authedRequest(token: string, body?: unknown): Request {
  const init: RequestInit = {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      "content-type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request("http://local.test", init);
}

function plainRequest(): Request {
  return new Request("http://local.test", { method: "POST" });
}

async function params(campaignId: string) {
  return { params: Promise.resolve({ campaignId }) };
}

function expectReadyOrCurrent(status: string | null | undefined): void {
  expect(["ready", "current"]).toContain(status);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Campaign Execution (Step 16) — durable runner + API", () => {
  // ============================ auth & guards ==============================

  it("1. execute requires auth", async () => {
    const res = await executeRoute(plainRequest(), await params("c1"));
    expect(res.status).toBe(401);
  });

  it("2. execution report requires auth", async () => {
    const res = await executionRoute(plainRequest(), await params("c1"));
    expect(res.status).toBe(401);
  });

  it("3. stop requires auth", async () => {
    const res = await stopRoute(plainRequest(), await params("c1"));
    expect(res.status).toBe(401);
  });

  it("4. pause requires auth", async () => {
    const res = await pauseRoute(plainRequest(), await params("c1"));
    expect(res.status).toBe(401);
  });

  it("5. resume requires auth", async () => {
    const res = await resumeRoute(plainRequest(), await params("c1"));
    expect(res.status).toBe(401);
  });

  it("6. execute returns 404 for an unknown campaign", async () => {
    const token = await adminToken();
    const res = await executeRoute(authedRequest(token), await params("missing"));
    expect(res.status).toBe(404);
  });

  it("7. execution report returns 404 for an unknown campaign", async () => {
    const token = await adminToken();
    const res = await executionRoute(authedRequest(token), await params("missing"));
    expect(res.status).toBe(404);
  });

  it("8. stop returns 404 for an unknown campaign", async () => {
    const token = await adminToken();
    const res = await stopRoute(authedRequest(token), await params("missing"));
    expect(res.status).toBe(404);
  });

  it("9. execute rejects duplicates while a campaign execution job is active", async () => {
    const token = await adminToken();
    const { campaign } = seedProspect(makePlaceId("dup"));
    const active = createJob({ type: "campaign_orchestration", campaignId: campaign.id });
    tryTransitionJobStatus(active.id, ["queued"], "running");
    const res = await executeRoute(authedRequest(token), await params(campaign.id));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/active execution job/i);
  });

  // ============================ route behaviour ============================

  it("10. POST execute runs a seeded campaign to a parked approval state", async () => {
    const token = await adminToken();
    const { lead, campaign } = seedProspect(makePlaceId("route-run"));
    const res = await executeRoute(authedRequest(token), await params(campaign.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CampaignExecutionSummary;
    expect(body.campaignId).toBe(campaign.id);
    const prospect = body.prospects.find((p) => p.leadId === lead.id);
    expect(prospect?.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");
    expect(prospect?.parked).toBe(true);
    expect(body.stopped).toBe(false);
    // Website was actually generated offline end-to-end.
    const current = getCurrentWebsiteVersion(lead.id);
    expectReadyOrCurrent(current?.status);
    expect(current?.buildStatus).toBe("success");
    expect(current?.qaStatus).toBe("pass");
  });

  it("11. GET execution report reflects the latest run state", async () => {
    const token = await adminToken();
    const { lead, campaign } = seedProspect(makePlaceId("report"));
    await runExecution(campaign.id);
    const res = await executionRoute(authedRequest(token), await params(campaign.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CampaignExecutionSummary;
    const prospect = body.prospects.find((p) => p.leadId === lead.id);
    expect(prospect).toBeDefined();
    expect(prospect?.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");
    expect(typeof prospect?.reason).toBe("string");
    expect(prospect?.parked).toBe(true);
  });

  it("12. stop is durable: execute after stop refuses to run more work", async () => {
    const token = await adminToken();
    const { lead, campaign } = seedProspect(makePlaceId("stopped"));
    const stopRes = await stopRoute(authedRequest(token), await params(campaign.id));
    expect(stopRes.status).toBe(200);
    expect(getCampaign(campaign.id)?.status).toMatch(/stop/i);
    const res = await executeRoute(authedRequest(token), await params(campaign.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CampaignExecutionSummary;
    expect(body.stopped).toBe(true);
    expect(listWebsiteVersions(lead.id).length).toBe(0);
  });

  it("13. pause is durable: execute after pause parks without creating work", async () => {
    const token = await adminToken();
    const { lead, campaign } = seedProspect(makePlaceId("paused"));
    const pauseRes = await pauseRoute(authedRequest(token), await params(campaign.id));
    expect(pauseRes.status).toBe(200);
    expect(getCampaign(campaign.id)?.status).toMatch(/paus/i);
    const res = await executeRoute(authedRequest(token), await params(campaign.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CampaignExecutionSummary;
    expect(body.stopped).toBe(false);
    expect(listWebsiteVersions(lead.id).length).toBe(0);
  });

  it("14. resume unblocks a paused campaign and execution proceeds", async () => {
    const token = await adminToken();
    const { lead, campaign } = seedProspect(makePlaceId("resume"));
    await pauseRoute(authedRequest(token), await params(campaign.id));
    const resumeRes = await resumeRoute(authedRequest(token), await params(campaign.id));
    expect(resumeRes.status).toBe(200);
    expect(getCampaign(campaign.id)?.status).toMatch(/active/i);
    const res = await executeRoute(authedRequest(token), await params(campaign.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CampaignExecutionSummary;
    expect(listWebsiteVersions(lead.id).length).toBeGreaterThan(0);
    expect(body.prospects[0]?.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");
  });

  it("15. execution report for an empty fresh campaign has no prospects", async () => {
    const token = await adminToken();
    const campaign = createCampaign({
      niche: "Plumbing",
      location: "Nowhere",
      requestedLeadCount: 5,
      status: "running",
    });
    const res = await executionRoute(authedRequest(token), await params(campaign.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CampaignExecutionSummary;
    expect(body.prospects.length).toBe(0);
    expect(body.processingStarted).toBe(false);
  });

  // ============================ discovery phase ============================

  it("16. empty campaign runs discovery via injected services and links prospects", async () => {
    const campaign = createCampaign({
      niche: "Plumbing",
      location: "Nowhere",
      requestedLeadCount: 2,
      status: "running",
    });
    const discoverCalls: string[] = [];
    const discover: DiscoverLeadsFn = async (niche, location, count) => {
      discoverCalls.push(`${niche}|${location}|${count}`);
      return [
        makeLead(makePlaceId("d1"), "Bob's Plumbing"),
        makeLead(makePlaceId("d2"), "Ed's Drains"),
        makeLead(makePlaceId("d3"), "Extra Co"),
      ];
    };
    const qualify: QualifyLeadsFn = async (_niche, _location, leads) =>
      leads.map((lead) => ({ ...lead, qualification: websiteQualification("NO_WEBSITE") }));
    const outcome = await runExecution(campaign.id, {
      discoverLeads: discover,
      qualifyLeads: qualify,
      researchLeads: completeResearchForAll,
    });
    expect(discoverCalls.length).toBe(1);
    expect(outcome.result.discoveredProspects).toBe(2);
    expect(outcome.result.prospects.length).toBe(2);
    // Discovery honours the campaign lead count for the pool request.
    expect(discoverCalls[0]).toContain("2");
  });

  it("17. discovery filters to genuine opportunities only", async () => {
    const campaign = createCampaign({
      niche: "Plumbing",
      location: "Nowhere",
      requestedLeadCount: 5,
      status: "running",
    });
    const discover: DiscoverLeadsFn = async () => [
      makeLead(makePlaceId("g1"), "Good Co"),
      makeLead(makePlaceId("n1"), "No Site Co"),
      makeLead(makePlaceId("r1"), "Redesign Co"),
    ];
    const qualify: QualifyLeadsFn = async (_n, _l, leads) =>
      leads.map((lead, index) => ({
        ...lead,
        qualification:
          index === 0
            ? websiteQualification("GOOD_WEBSITE", false)
            : index === 1
              ? websiteQualification("NO_WEBSITE")
              : websiteQualification("NEEDS_REDESIGN"),
      }));
    const outcome = await runExecution(campaign.id, {
      discoverLeads: discover,
      qualifyLeads: qualify,
      researchLeads: completeResearchForAll,
    });
    const names = new Set(outcome.result.prospects.map((p) => p.businessName));
    expect(names.has("No Site Co")).toBe(true);
    expect(names.has("Redesign Co")).toBe(true);
    expect(names.has("Good Co")).toBe(false);
  });

  it("18. discovery is skipped when the campaign already has linked leads", async () => {
    const { campaign } = seedProspect(makePlaceId("has-leads"));
    let discoverCalled = false;
    const discover: DiscoverLeadsFn = async () => {
      discoverCalled = true;
      return [];
    };
    const qualify: QualifyLeadsFn = async () => [];
    await runExecution(campaign.id, { discoverLeads: discover, qualifyLeads: qualify });
    expect(discoverCalled).toBe(false);
    expect(getCampaignExecutionSummary(campaign.id)?.discoveredProspects).toBe(1);
  });

  it("19. discovery respects the campaign requestedLeadCount", async () => {
    const campaign = createCampaign({
      niche: "Plumbing",
      location: "Nowhere",
      requestedLeadCount: 2,
      status: "running",
    });
    const discover: DiscoverLeadsFn = async () =>
      Array.from({ length: 4 }, (_, i) => makeLead(makePlaceId(`c${i}`), `Co ${i}`));
    const qualify: QualifyLeadsFn = async (_n, _l, leads) =>
      leads.map((lead) => ({ ...lead, qualification: websiteQualification("NO_WEBSITE") }));
    const outcome = await runExecution(campaign.id, {
      discoverLeads: discover,
      qualifyLeads: qualify,
      researchLeads: completeResearchForAll,
    });
    expect(outcome.result.discoveredProspects).toBeGreaterThan(0);
    expect(outcome.result.discoveredProspects).toBeLessThanOrEqual(2);
  });

  // ============================ research stage =============================

  it("20. RESEARCH_BUSINESS persists research then proceeds to website creation", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("research-ok"), {
      research: null,
    });
    const researchFn = async (leads: Array<{ placeId: string }>) =>
      leads.map((l) => completeResearch(l.placeId));
    const outcome = await runExecution(campaign.id, { researchLeads: researchFn as never });
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");
    expect(listWebsiteVersions(lead.id).length).toBeGreaterThan(0);
  });

  it("21. research failure retries then durably skips the prospect", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("research-fail"), {
      research: null,
    });
    const researchFn = async (leads: Array<{ placeId: string }>) =>
      leads.map((l) => failingResearch(l.placeId));
    const outcome = await runExecution(campaign.id, {
      researchLeads: researchFn as never,
      maxAttempts: 2,
    });
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.skipped).toBe(true);
    expect(report.attempts.RESEARCH_BUSINESS).toBe(2);
    expect(listWebsiteVersions(lead.id).length).toBe(0);
  });

  // ============================ website pipeline ===========================

  it("22. seedProspect without a version → CREATE_WEBSITE executes and parks at approval", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("create"));
    const outcome = await runExecution(campaign.id);
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");
    expect(report.parked).toBe(true);
    const current = getCurrentWebsiteVersion(lead.id);
    expectReadyOrCurrent(current?.status);
    expect(current?.buildStatus).toBe("success");
    expect(current?.qaStatus).toBe("pass");
    expect(current?.artifactHash).toBeTruthy();
  });

  it("23. draft version → CODE_WEBSITE then RUN_WEBSITE_QA reach readiness", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("code"));
    createWebsiteProjectVersion(lead.id);
    const outcome = await runExecution(campaign.id);
    const version = getLatestWebsiteVersion(lead.id);
    expectReadyOrCurrent(version?.status);
    expect(version?.buildStatus).toBe("success");
    expect(version?.qaStatus).toBe("pass");
    expect(version?.artifactHash).toBeTruthy();
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");
  });

  it("24. version parked in QA → RUN_WEBSITE_QA completes it to ready", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("qa-resume"));
    const version = createWebsiteProjectVersion(lead.id);
    updateWebsiteVersionResult(version.projectId, { status: "building", buildStatus: "building" });
    updateWebsiteVersionResult(version.projectId, { status: "qa", qaStatus: "qa" });
    const outcome = await runExecution(campaign.id);
    const latest = getLatestWebsiteVersion(lead.id);
    expectReadyOrCurrent(latest?.status);
    expect(latest?.qaStatus).toBe("pass");
    expect(latest?.artifactHash).toBeTruthy();
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");
  });

  it("25. failed version → FIX_WEBSITE regenerates a new version instead of retrying forever", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("fix"));
    const version = createWebsiteProjectVersion(lead.id);
    updateWebsiteVersionResult(version.projectId, { status: "building", buildStatus: "building" });
    updateWebsiteVersionResult(version.projectId, { status: "failed" });
    const outcome = await runExecution(campaign.id);
    const versions = listWebsiteVersions(lead.id);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const latest = getLatestWebsiteVersion(lead.id);
    expectReadyOrCurrent(latest?.status);
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.skipped).toBe(false);
  });

  it("26. stopped version → cooperative STOP ends the run", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("vstop"));
    const version = createWebsiteProjectVersion(lead.id);
    updateWebsiteVersionResult(version.projectId, { status: "stopped" });
    const outcome = await runExecution(campaign.id);
    expect(outcome.result.stopped).toBe(true);
    expect(listWebsiteVersions(lead.id).length).toBe(1);
  });

  // ============================ deployment gates ===========================

  it("27. deployable current version without approval → parked, never deployed", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("no-approval"));
    seedVersionReadyAndCurrent(lead.id);
    const outcome = await runExecution(campaign.id);
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");
    expect(listDeploymentRecordsByLead(lead.id).length).toBe(0);
    expect(listOutreachDraftsByLead(lead.id).length).toBe(0);
  });

  it("28. non-matching deployment approval → still parked (approval binding matters)", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("wrong-approval"));
    const version = seedVersionReadyAndCurrent(lead.id, { artifactHash: "artifact-y" });
    seedDeploymentApprovalForVersion(lead.id, version.projectId, "artifact-x");
    const outcome = await runExecution(campaign.id);
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");
    expect(listDeploymentRecordsByLead(lead.id).length).toBe(0);
  });

  it("29. full pipeline: build → approve → deploy → draft → parked for outreach approval", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("full"));
    const { registry } = mockRegistry();

    // Phase A — build.
    let outcome = await runExecution(campaign.id, { registry });
    let report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");

    // Human approves the exact current version + artifact hash.
    const current = getCurrentWebsiteVersion(lead.id)!;
    seedDeploymentApprovalForVersion(lead.id, current.projectId, current.artifactHash!);

    // Phase B — deploy, draft, park.
    outcome = await runExecution(campaign.id, { registry });
    report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("WAIT_FOR_OUTREACH_APPROVAL");

    const deployments = listDeploymentRecordsByLead(lead.id);
    expect(deployments.some((d) => d.status === "ready" && d.deploymentUrl)).toBe(true);
    const drafts = listOutreachDraftsByLead(lead.id);
    expect(drafts.some((d) => d.status === "eligible")).toBe(true);
    // Nothing may ever be sent by the runner.
    expect(listOutreachSendsByLead(lead.id).length).toBe(0);
  });

  it("30. failed deployment → RETRY_STEP redeploys and recovers", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("retry"));
    const { registry } = mockRegistry();

    // Build the version through the real flow so a deploy is possible.
    await runExecution(campaign.id, { registry });
    const current = getCurrentWebsiteVersion(lead.id)!;
    seedDeploymentApprovalForVersion(lead.id, current.projectId, current.artifactHash!);

    // A failed attempt with no live URL → evaluation says RETRY.
    let failed = createDeploymentRecord({
      websiteProjectId: current.websiteProjectId!,
      leadId: lead.id,
      websiteVersionId: current.projectId,
      version: current.version,
      provider: "mock",
      artifactHash: current.artifactHash ?? "artifact-x",
    });
    failed = updateDeploymentRecord(failed.id, { status: "validating" });
    failed = updateDeploymentRecord(failed.id, { status: "uploading" });
    markDeploymentFailed(failed.id, "host error");
    const decision = evaluateNextAction({ leadId: lead.id });
    expect(decision.state).toBe("RETRY_STEP");

    const outcome = await runExecution(campaign.id, { registry });
    const after = listDeploymentRecordsByLead(lead.id);
    expect(after.some((d) => d.status === "ready" && d.deploymentUrl)).toBe(true);
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("WAIT_FOR_OUTREACH_APPROVAL");
  });

  it("31. deployment without a usable registry fails closed and skips the prospect", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("no-provider"));
    const version = seedVersionReadyAndCurrent(lead.id);
    seedDeploymentApprovalForVersion(lead.id, version.projectId, "artifact-x");
    const outcome = await runExecution(campaign.id, { maxAttempts: 2 });
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.skipped).toBe(true);
    expect(report.attempts.DEPLOY_WEBSITE ?? 0).toBeGreaterThan(0);
    expect(listDeploymentRecordsByLead(lead.id).length).toBe(0);
  });

  // ============================ outreach gates =============================

  it("32. runner-generated draft is eligible, bound to the current version and live URL", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("draft-gen"));
    const { registry } = mockRegistry();
    await runExecution(campaign.id, { registry });
    const current = getCurrentWebsiteVersion(lead.id)!;
    seedDeploymentApprovalForVersion(lead.id, current.projectId, current.artifactHash!);
    await runExecution(campaign.id, { registry });
    const drafts = listOutreachDraftsByLead(lead.id);
    expect(drafts.length).toBe(1);
    expect(drafts[0].status).toBe("eligible");
    expect(drafts[0].websiteVersionId).toBe(current.projectId);
    expect(drafts[0].websiteUrl).toMatch(/^https?:\/\//);
    expect(drafts[0].subject).toContain("website is live");
  });

  it("33. full runner pipeline never sends email", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("never-send"));
    const { registry } = mockRegistry();
    await runExecution(campaign.id, { registry });
    const current = getCurrentWebsiteVersion(lead.id)!;
    seedDeploymentApprovalForVersion(lead.id, current.projectId, current.artifactHash!);
    const outcome = await runExecution(campaign.id, { registry });
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("WAIT_FOR_OUTREACH_APPROVAL");
    expect(report.terminal).toBe(false);
    expect(listOutreachSendsByLead(lead.id).length).toBe(0);
  });

  it("34. runner-generated draft passes Agent 8 and reaches READY once approved", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("safe-copy"));
    const { registry } = mockRegistry();
    await runExecution(campaign.id, { registry });
    const current = getCurrentWebsiteVersion(lead.id)!;
    seedDeploymentApprovalForVersion(lead.id, current.projectId, current.artifactHash!);
    await runExecution(campaign.id, { registry });

    const drafts = listOutreachDraftsByLead(lead.id);
    expect(drafts.length).toBe(1);
    seedOutreachApproval(lead.id, drafts[0].id, CONTACT_EMAIL);

    process.env.EMAIL_TRANSPORT_CONFIGURED = "true";
    const outcome = await runExecution(campaign.id, { registry });
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("READY_FOR_TRANSPORT");
    expect(report.terminal).toBe(true);
    // Intent only — the runner still never sends.
    expect(listOutreachSendsByLead(lead.id).length).toBe(0);
  });

  it("35. blocked draft → SKIP_PROSPECT, nothing is created or sent", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("blocked"));
    seedDeployedLiveSite(lead.id, LIVE_URL);
    seedDraft(lead.id, { status: "blocked" });
    const outcome = await runExecution(campaign.id);
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.skipped).toBe(true);
    expect(report.terminal).toBe(true);
    expect(listOutreachSendsByLead(lead.id).length).toBe(0);
  });

  it("36. pending_review draft only → parked, never auto-eligible", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("pending"));
    seedDeployedLiveSite(lead.id, LIVE_URL);
    seedDraft(lead.id, { status: "pending_review" });
    const outcome = await runExecution(campaign.id);
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.parked).toBe(true);
    expect(listOutreachSendsByLead(lead.id).length).toBe(0);
  });

  it("37. recorded opt-out → SKIP_PROSPECT, never deployed or written", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("optout"));
    recordOutreachOptOut(lead.id, "unsubscribe", "test");
    const outcome = await runExecution(campaign.id);
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.skipped).toBe(true);
    expect(report.terminal).toBe(true);
    expect(listWebsiteVersions(lead.id).length).toBe(0);
    expect(listOutreachDraftsByLead(lead.id).length).toBe(0);
  });

  // ============================ stop / pause durability =====================

  it("38. stopped campaign never performs work", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("pre-stop"), {
      campaignStatus: "stopped",
    });
    const outcome = await runExecution(campaign.id);
    expect(outcome.result.stopped).toBe(true);
    expect(listWebsiteVersions(lead.id).length).toBe(0);
    expect(getCampaign(campaign.id)?.status).toMatch(/stop/i);
  });

  it("39. paused campaign parks everything", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("pre-pause"), {
      campaignStatus: "paused",
    });
    const outcome = await runExecution(campaign.id);
    expect(outcome.result.stopped).toBe(false);
    expect(listWebsiteVersions(lead.id).length).toBe(0);
  });

  it("40. cooperative stop request aborts the run and marks the job stopped", async () => {
    const { campaign } = seedProspect(makePlaceId("coop-stop"));
    await expect(
      runJob(
        { type: "campaign_orchestration", campaignId: campaign.id, metadata: {} },
        async (controller) => {
          controller.requestStop();
          return runCampaignExecution(campaign.id, { controller });
        },
      ),
    ).rejects.toBeInstanceOf(JobStopped);
  });

  it("41. runner refuses to start when another execution job owns the campaign", async () => {
    // Warm the process-wide stale-job check so the fake active job is respected.
    const warm = seedProspect(makePlaceId("warm"), { campaignStatus: "stopped" });
    await runExecution(warm.campaign.id);

    const { campaign } = seedProspect(makePlaceId("busy-run"));
    const active = createJob({ type: "campaign_orchestration", campaignId: campaign.id });
    tryTransitionJobStatus(active.id, ["queued"], "running");
    await expect(runExecution(campaign.id)).rejects.toThrow(/active execution job/);
  });

  // ============================ prospect isolation ==========================

  it("42. two prospects at different stages advance independently in one run", async () => {
    const a = seedProspect(makePlaceId("iso-a"));
    const b = seedProspect(makePlaceId("iso-b"));
    linkCampaignLead(a.campaign.id, b.lead.id);
    setLeadPrimaryCampaign(b.lead.id, a.campaign.id);

    // A is blocked (opt-out) → skipped. B has no version → built.
    recordOutreachOptOut(a.lead.id, "unsubscribe", "test");
    const outcome = await runExecution(a.campaign.id);
    expect(outcome.result.prospects.length).toBe(2);
    const ra = outcome.result.prospects.find((p) => p.leadId === a.lead.id)!;
    const rb = outcome.result.prospects.find((p) => p.leadId === b.lead.id)!;
    expect(ra.skipped).toBe(true);
    expect(rb.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");
    expect(getLatestWebsiteVersion(a.lead.id)).toBeNull();
    expect(getCurrentWebsiteVersion(b.lead.id)).not.toBeNull();
    expect(outcome.result.campaignId).toBe(a.campaign.id);
  });

  it("43. one prospect hitting its terminal state does not stall the other", async () => {
    const x = seedProspect(makePlaceId("term-x"));
    const y = seedProspect(makePlaceId("term-y"));
    linkCampaignLead(x.campaign.id, y.lead.id);
    setLeadPrimaryCampaign(y.lead.id, x.campaign.id);
    recordOutreachOptOut(y.lead.id, "reported", "test");
    const outcome = await runExecution(x.campaign.id);
    const rx = outcome.result.prospects.find((p) => p.leadId === x.lead.id)!;
    const ry = outcome.result.prospects.find((p) => p.leadId === y.lead.id)!;
    expect(ry.skipped).toBe(true);
    expect(rx.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");
  });

  // ============================ idempotency / resume ========================

  it("44. re-running a parked campaign performs no additional work", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("idem"));
    await runExecution(campaign.id);
    const versionCount = listWebsiteVersions(lead.id).length;
    const deploymentCount = listDeploymentRecordsByLead(lead.id).length;

    const outcome = await runExecution(campaign.id);
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");
    expect(listWebsiteVersions(lead.id).length).toBe(versionCount);
    expect(listDeploymentRecordsByLead(lead.id).length).toBe(deploymentCount);
  });

  it("45. resume after human approval continues from the parked state (no website re-build)", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("resume2"));
    const { registry } = mockRegistry();
    await runExecution(campaign.id, { registry });
    expect(listWebsiteVersions(lead.id).length).toBe(1);

    const current = getCurrentWebsiteVersion(lead.id)!;
    seedDeploymentApprovalForVersion(lead.id, current.projectId, current.artifactHash!);

    const outcome = await runExecution(campaign.id, { registry });
    expect(listWebsiteVersions(lead.id).length).toBe(1);
    expect(listDeploymentRecordsByLead(lead.id).some((d) => d.status === "ready")).toBe(true);
    const report = outcome.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("WAIT_FOR_OUTREACH_APPROVAL");
  });

  it("46. attempt counters persist across runs and skip is not re-attempted", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("merge"), { research: null });
    const researchFn = async (leads: Array<{ placeId: string }>) =>
      leads.map((l) => failingResearch(l.placeId));
    const services: CampaignExecutionServices = {
      researchLeads: researchFn as never,
      maxAttempts: 2,
    };
    await runExecution(campaign.id, services);
    const second = await runExecution(campaign.id, services);
    const report = second.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.skipped).toBe(true);
    expect(report.attempts.RESEARCH_BUSINESS).toBe(2);
  });

  // ============================ fail-closed guarantees ======================

  it("47. deployment approval plus ready version is required before any deployment record", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("failclosed"));
    const version = seedVersionReadyAndCurrent(lead.id);
    const outcome = await runExecution(campaign.id);
    expect(outcome.result.prospects[0]?.state).toBe("WAIT_FOR_DEPLOYMENT_APPROVAL");
    expect(listDeploymentRecordsByLead(lead.id).length).toBe(0);
    // Still no record after a large retry budget — failing is safer than deploying.
    await runExecution(campaign.id, { maxAttempts: 10 });
    expect(listDeploymentRecordsByLead(lead.id).length).toBe(0);
    void version;
  });

  it("48. READY_FOR_TRANSPORT is terminal and repeat runs never send", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("terminal-ready"));
    seedDeployedLiveSite(lead.id, LIVE_URL);
    const draft = seedDraft(lead.id);
    seedOutreachApproval(lead.id, draft.id, CONTACT_EMAIL);

    process.env.EMAIL_TRANSPORT_CONFIGURED = "true";
    const first = await runExecution(campaign.id);
    const report = first.result.prospects.find((p) => p.leadId === lead.id)!;
    expect(report.state).toBe("READY_FOR_TRANSPORT");
    expect(report.terminal).toBe(true);

    await runExecution(campaign.id);
    expect(listOutreachSendsByLead(lead.id).length).toBe(0);
    expect(listOutreachDraftsByLead(lead.id).length).toBe(1);
  });

  it("49. campaign halted/cancelled statuses are honoured as stopped", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("halted"), {
      campaignStatus: "halted",
    });
    const outcome = await runExecution(campaign.id);
    expect(outcome.result.stopped).toBe(true);
    expect(listWebsiteVersions(lead.id).length).toBe(0);
  });

  // ============================ execution report ============================

  it("50. execution report surfaces skipped flag and attempt counters", async () => {
    const { lead, campaign } = seedProspect(makePlaceId("report2"), { research: null });
    const researchFn = async (leads: Array<{ placeId: string }>) =>
      leads.map((l) => failingResearch(l.placeId));
    await runExecution(campaign.id, {
      researchLeads: researchFn as never,
      maxAttempts: 2,
    });
    const report = getCampaignExecutionSummary(campaign.id);
    expect(report).not.toBeNull();
    const prospect = report!.prospects.find((p) => p.leadId === lead.id)!;
    expect(prospect.skipped).toBe(true);
    expect(prospect.attempts.RESEARCH_BUSINESS).toBe(2);
    expect(report!.discoveredProspects).toBe(1);
  });

  it("51. execution report on a stopped campaign reports stopped=true", async () => {
    const { campaign } = seedProspect(makePlaceId("report-stop"), {
      campaignStatus: "stopped",
    });
    const report = getCampaignExecutionSummary(campaign.id);
    expect(report?.stopped).toBe(true);
  });

  it("52. summary discoveredProspects/processingStarted reflect reality", async () => {
    const { campaign } = seedProspect(makePlaceId("counts"));
    const outcome = await runExecution(campaign.id);
    expect(outcome.result.discoveredProspects).toBe(1);
    expect(outcome.result.processingStarted).toBe(true);
    expect(outcome.result.campaignStatus).toBe("running");
    expect(outcome.result.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });
});