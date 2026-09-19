/**
 * GET /api/admin/outreach/send-status — read-only real-email preflight tests.
 *
 * The preflight endpoint must be a pure reader: it evaluates Agent 8 / Agent 10
 * side-effect free, writes nothing (no send authorization, no rows, no idempotency
 * claim), never contacts the provider, never attempts transport, and exposes no
 * secrets. It reports exactly what the controlled send would send, with every
 * safety gate and its status, and a final READY / NOT_READY result. It must
 * ignore any client-supplied override beyond prospectId + draftId.
 *
 * The send itself still requires the authenticated POST mutation on
 * /api/admin/outreach/send-test with confirm: true.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getDb } from "@/lib/data/db";
import { resetDatabase } from "@/lib/data/schema";
import { createCampaign, linkCampaignLead } from "@/lib/data/campaigns";
import {
  setLeadPrimaryCampaign,
  updateLeadContactDiscovery,
  updateLeadQualificationData,
  upsertLeadFromDiscovery,
} from "@/lib/data/leads";
import {
  createOutreachApproval,
  createOutreachDraft,
  recordOutreachOptOut,
  updateOutreachDraftStatus,
} from "@/lib/data/outreach";
import {
  createWebsiteProjectVersion,
  promoteWebsiteVersion,
  updateWebsiteVersionResult,
} from "@/lib/data/websites";
import {
  createDeploymentRecord,
  updateDeploymentRecord,
} from "@/lib/data/deployments";
import { createDeploymentApproval } from "@/lib/data/deployment-approvals";
import { upsertResearch } from "@/lib/data/research";
import { createSessionToken } from "@/lib/auth/session";
import { normalizeRecipientEmail } from "@/lib/outreach-safety/safety";
import { GET } from "@/app/api/admin/outreach/send-status/route";
import { makeLead, makeQualification, makeResearch } from "./helpers";
import type { ContactDiscovery } from "@/lib/contact-discovery";

const CONTACT_EMAIL = "office@acme.test";
const OTHER_EMAIL = "desk@other.test";
const SAFE_SUBJECT = "Quick intro";
const SAFE_BODY =
  "Hello! We design modern marketing websites that improve online visibility. " +
  "Would you be open to a quick conversation about how we could help improve your site?";
const LIVE_URL = "https://live.acme-site.com";
const ARTIFACT_HASH = "artifact-x";
const FAKE_KEY = "re_1234567890abcdef";
const FROM_EMAIL = "hello@example.com";

const TABLE_NAMES = [
  "activity_log",
  "agent_jobs",
  "campaign_leads",
  "campaigns",
  "deployment_approvals",
  "deployments",
  "leads",
  "migrations",
  "outreach_approvals",
  "outreach_drafts",
  "outreach_opt_outs",
  "outreach_sends",
  "research",
  "website_projects",
  "website_versions",
];

let sequence = 0;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sequence += 1;
  resetDatabase(getDb());
  process.env.SESSION_SECRET = "test-secret";
  delete process.env.EMAIL_TRANSPORT_CONFIGURED;
  delete process.env.EMAIL_TRANSPORT_PROVIDER;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;

  process.env.RESEND_API_KEY = FAKE_KEY;
  process.env.RESEND_FROM_EMAIL = FROM_EMAIL;
  process.env.EMAIL_TRANSPORT_CONFIGURED = "true";
  process.env.EMAIL_TRANSPORT_PROVIDER = "resend";

  fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: "resend_message_001" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  delete process.env.EMAIL_TRANSPORT_CONFIGURED;
  delete process.env.EMAIL_TRANSPORT_PROVIDER;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  vi.unstubAllGlobals();
});

function makePlaceId(label: string): string {
  return `send-status-${sequence}-${label}`;
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

function seedFullReady(
  placeId: string,
  options: {
    email?: string;
    outreachApproval?: boolean;
    deploymentApproval?: boolean;
    campaignStatus?: string;
  } = {},
) {
  const leadSource = makeLead(placeId, `${placeId} biz`);
  const upsert = upsertLeadFromDiscovery(leadSource);
  const lead = upsert.lead;
  updateLeadQualificationData(lead.id, {
    ...makeQualification(),
    qualified: true,
    websiteOpportunity: "NO_WEBSITE",
  });
  updateLeadContactDiscovery(lead.id, verifiedContact(options.email));
  const campaign = createCampaign({
    niche: "Roofing",
    location: "Nowhere",
    requestedLeadCount: 5,
    status: options.campaignStatus ?? "running",
  });
  linkCampaignLead(campaign.id, lead.id);
  setLeadPrimaryCampaign(lead.id, campaign.id);
  upsertResearch(lead.id, makeResearch());

  const version = createWebsiteProjectVersion(lead.id);
  updateWebsiteVersionResult(version.projectId, { status: "building", buildStatus: "building" });
  updateWebsiteVersionResult(version.projectId, { status: "qa", qaStatus: "qa" });
  updateWebsiteVersionResult(version.projectId, {
    status: "ready",
    buildStatus: "success",
    qaStatus: "pass",
    artifactHash: ARTIFACT_HASH,
  });
  promoteWebsiteVersion(version.projectId);
  if (options.deploymentApproval !== false) {
    createDeploymentApproval({
      leadId: lead.id,
      websiteVersionId: version.projectId,
      artifactHash: ARTIFACT_HASH,
      createdBy: "user-1",
    });
  }

  let deployment = createDeploymentRecord({
    websiteProjectId: version.websiteProjectId!,
    leadId: lead.id,
    websiteVersionId: version.projectId,
    version: version.version,
    provider: "mock",
    artifactHash: ARTIFACT_HASH,
  });
  for (const status of ["validating", "uploading", "building", "deploying"])
    deployment = updateDeploymentRecord(deployment.id, { status: status as never });
  deployment = updateDeploymentRecord(deployment.id, {
    status: "ready",
    deploymentUrl: LIVE_URL,
  });

  const draft = createOutreachDraft({
    leadId: lead.id,
    subject: SAFE_SUBJECT,
    body: SAFE_BODY,
    status: "eligible",
    websiteVersionId: version.projectId,
    websiteUrl: LIVE_URL,
  });
  if (options.outreachApproval !== false) {
    createOutreachApproval({
      leadId: lead.id,
      draftId: draft.id,
      recipientEmail: normalizeRecipientEmail(options.email ?? CONTACT_EMAIL),
      draftHash: draft.contentHash,
      createdBy: "user-1",
    });
  }

  return { lead, campaign, draft, version, deployment };
}

async function statusRequest(
  prospectId: string,
  draftId: string,
  overrides: { auth?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    host: "localhost",
    origin: "http://localhost",
  };
  if (overrides.auth !== false) {
    const token = await createSessionToken("admin");
    headers.cookie = `aicf_session=${encodeURIComponent(token)}`;
  }
  const request = new Request(
    `http://localhost/api/admin/outreach/send-status?prospectId=${encodeURIComponent(
      prospectId,
    )}&draftId=${encodeURIComponent(draftId)}`,
    { method: "GET", headers },
  );
  return GET(request);
}

function sendRowCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM outreach_sends")
    .get() as { n: number };
  return row.n;
}

function snapshotDb(): string {
  const db = getDb();
  return JSON.stringify(
    TABLE_NAMES.map((table) => ({
      table,
      rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    })),
  );
}

function gateById(gates: Array<{ id: string; passed: boolean }>, id: string) {
  return gates.find((g) => g.id === id);
}

describe("Outreach send-status — real-email preflight (read-only)", () => {
  it("A. a valid fully-approved prospect reports READY with full preview and no side effects", async () => {
    const placeId = makePlaceId("ready");
    const fix = seedFullReady(placeId);
    const response = await statusRequest(fix.lead.id, fix.draft.id);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result).toBe("READY");
    expect(body.ready).toBe(true);
    expect(body.alreadySent).toBe(false);
    expect(body.blockedReason).toBeNull();

    expect(body.prospect).toMatchObject({
      id: fix.lead.id,
      businessName: `${placeId} biz`,
    });
    expect(body.recipientEmail).toBe(CONTACT_EMAIL);

    expect(body.draft).toMatchObject({
      id: fix.draft.id,
      subject: SAFE_SUBJECT,
      body: SAFE_BODY,
      contentHash: fix.draft.contentHash,
      status: "eligible",
    });

    expect(body.websiteVersion).toMatchObject({
      id: fix.version.projectId,
      deploymentUrl: LIVE_URL,
      deploymentStatus: "ready",
      artifactHash: ARTIFACT_HASH,
    });

    expect(body.campaign.status).toBe("running");
    expect(body.optOut).toBe(false);
    expect(body.provider).toMatchObject({ id: "resend", configured: true });
    expect(body.agent8.decision).toBe("SEND");
    expect(body.agent10.decision).toBe("TRANSPORT_READY");
    expect(body.approval).toMatchObject({
      valid: true,
      boundToDraft: true,
      boundToRecipient: true,
      boundToProspect: true,
    });

    expect(body.gates.length).toBeGreaterThan(0);
    expect(body.gates.every((g: { passed: boolean }) => g.passed)).toBe(true);
    for (const id of [
      "outreach.opt_out",
      "outreach.approval",
      "transport.agent8_decision",
      "transport.draft_content_hash",
      "transport.deployment",
      "transport.deployment_approval",
      "transport.approval",
      "transport.provider_supported",
      "transport.provider_configured",
    ]) {
      expect(gateById(body.gates, id)?.passed).toBe(true);
    }

    expect(JSON.stringify(body)).not.toContain("fromEmail");
    expect(sendRowCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("B. a missing approval reports NOT_READY with a safe blocked reason", async () => {
    const fix = seedFullReady(makePlaceId("not-approved"), { outreachApproval: false });
    const body = (await (await statusRequest(fix.lead.id, fix.draft.id)).json()) as {
      result: string;
      ready: boolean;
      blockedReason: string | null;
    };
    expect(body.result).toBe("NOT_READY");
    expect(body.ready).toBe(false);
    expect(body.blockedReason).toBeTruthy();
    expect(sendRowCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("C. an Agent 8 decision other than SEND reports NOT_READY", async () => {
    const fix = seedFullReady(makePlaceId("agent8-not-send"));
    updateOutreachDraftStatus(fix.draft.id, "blocked");
    const body = (await (await statusRequest(fix.lead.id, fix.draft.id)).json()) as {
      result: string;
      agent8: { decision: string };
      gates: Array<{ id: string; passed: boolean }>;
    };
    expect(body.agent8.decision).not.toBe("SEND");
    expect(body.result).toBe("NOT_READY");
    expect(gateById(body.gates, "outreach.draft_eligible")?.passed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("D. an Agent 10 decision other than TRANSPORT_READY reports NOT_READY even when Agent 8 says SEND", async () => {
    const fix = seedFullReady(makePlaceId("agent10-not-ready"), {
      deploymentApproval: false,
    });
    const body = (await (await statusRequest(fix.lead.id, fix.draft.id)).json()) as {
      result: string;
      agent8: { decision: string };
      agent10: { decision: string };
    };
    expect(body.agent8.decision).toBe("SEND");
    expect(body.agent10.decision).not.toBe("TRANSPORT_READY");
    expect(body.result).toBe("NOT_READY");
    expect(sendRowCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("E. an opt-out reports NOT_READY and never authorizes anything", async () => {
    const fix = seedFullReady(makePlaceId("optout"));
    recordOutreachOptOut(fix.lead.id, "unsubscribe", "test");
    const body = (await (await statusRequest(fix.lead.id, fix.draft.id)).json()) as {
      result: string;
      optOut: boolean;
    };
    expect(body.result).toBe("NOT_READY");
    expect(body.optOut).toBe(true);
    expect(sendRowCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("F. a stopped campaign reports NOT_READY", async () => {
    const fix = seedFullReady(makePlaceId("stopped"), { campaignStatus: "stopped" });
    const body = (await (await statusRequest(fix.lead.id, fix.draft.id)).json()) as {
      result: string;
      campaign: { status: string };
      agent8: { decision: string };
    };
    expect(body.campaign.status).toBe("stopped");
    expect(body.agent8.decision).toBe("REJECT");
    expect(body.result).toBe("NOT_READY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("G. a paused campaign reports NOT_READY", async () => {
    const fix = seedFullReady(makePlaceId("paused"), { campaignStatus: "paused" });
    const body = (await (await statusRequest(fix.lead.id, fix.draft.id)).json()) as {
      result: string;
      campaign: { status: string };
    };
    expect(body.campaign.status).toBe("paused");
    expect(body.result).toBe("NOT_READY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("H. changed draft content after approval reports NOT_READY (hash gate fails)", async () => {
    const fix = seedFullReady(makePlaceId("changed-draft"));
    getDb()
      .prepare("UPDATE outreach_drafts SET body = ? WHERE id = ?")
      .run(`${SAFE_BODY} altered after approval.`, fix.draft.id);
    const body = (await (await statusRequest(fix.lead.id, fix.draft.id)).json()) as {
      result: string;
      gates: Array<{ id: string; passed: boolean }>;
    };
    expect(body.result).toBe("NOT_READY");
    expect(gateById(body.gates, "transport.draft_content_hash")?.passed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("I. changed recipient after approval reports NOT_READY (approval binding gate fails)", async () => {
    const fix = seedFullReady(makePlaceId("changed-recipient"));
    updateLeadContactDiscovery(fix.lead.id, verifiedContact(OTHER_EMAIL));
    const body = (await (await statusRequest(fix.lead.id, fix.draft.id)).json()) as {
      result: string;
      recipientEmail: string;
      gates: Array<{ id: string; passed: boolean }>;
    };
    expect(body.recipientEmail).toBe(OTHER_EMAIL);
    expect(body.result).toBe("NOT_READY");
    expect(gateById(body.gates, "outreach.approval")?.passed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("J. a changed website version reports NOT_READY (version gate fails)", async () => {
    const fix = seedFullReady(makePlaceId("changed-version"));
    const newer = createWebsiteProjectVersion(fix.lead.id);
    updateWebsiteVersionResult(newer.projectId, { status: "building", buildStatus: "building" });
    updateWebsiteVersionResult(newer.projectId, { status: "qa", qaStatus: "qa" });
    updateWebsiteVersionResult(newer.projectId, {
      status: "ready",
      buildStatus: "success",
      qaStatus: "pass",
      artifactHash: "artifact-y",
    });
    promoteWebsiteVersion(newer.projectId);
    const body = (await (await statusRequest(fix.lead.id, fix.draft.id)).json()) as {
      result: string;
      websiteVersion: { id: string };
      gates: Array<{ id: string; passed: boolean }>;
    };
    expect(body.websiteVersion.id).toBe(newer.projectId);
    expect(body.result).toBe("NOT_READY");
    expect(gateById(body.gates, "outreach.website_version")?.passed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("K. an unavailable provider reports NOT_READY without any provider call", async () => {
    const fix = seedFullReady(makePlaceId("no-provider"));
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    const body = (await (await statusRequest(fix.lead.id, fix.draft.id)).json()) as {
      result: string;
      provider: { id: string; configured: boolean };
      gates: Array<{ id: string; passed: boolean }>;
    };
    expect(body.provider).toMatchObject({ id: "resend", configured: false });
    expect(body.result).toBe("NOT_READY");
    expect(gateById(body.gates, "transport.provider_configured")?.passed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unauthenticated request is rejected with 401 and no side effects", async () => {
    const fix = seedFullReady(makePlaceId("unauth"));
    const response = await statusRequest(fix.lead.id, fix.draft.id, { auth: false });
    expect(response.status).toBe(401);
    expect(sendRowCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing parameters returns 400", async () => {
    seedFullReady(makePlaceId("missing"));
    const token = await createSessionToken("admin");
    const request = new Request(
      "http://localhost/api/admin/outreach/send-status?prospectId=x",
      {
        method: "GET",
        headers: {
          host: "localhost",
          cookie: `aicf_session=${encodeURIComponent(token)}`,
        },
      },
    );
    const response = await GET(request);
    expect(response.status).toBe(400);
  });

  it("unknown prospect returns 404", async () => {
    const fix = seedFullReady(makePlaceId("no-prospect"));
    const response = await statusRequest("missing-prospect", fix.draft.id);
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unknown draft returns 404", async () => {
    const fix = seedFullReady(makePlaceId("no-draft"));
    const response = await statusRequest(fix.lead.id, "missing-draft");
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a draft belonging to another prospect returns 422", async () => {
    const fixA = seedFullReady(makePlaceId("cross-a"));
    const fixB = seedFullReady(makePlaceId("cross-b"), { email: OTHER_EMAIL });
    const response = await statusRequest(fixA.lead.id, fixB.draft.id);
    expect(response.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("L. repeated preflight evaluations make zero provider calls", async () => {
    const fix = seedFullReady(makePlaceId("no-provider-calls"));
    for (let i = 0; i < 3; i += 1) {
      const response = await statusRequest(fix.lead.id, fix.draft.id);
      expect(response.status).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(sendRowCount()).toBe(0);
  });

  it("M. evaluating the preflight performs zero DB writes (full snapshot unchanged)", async () => {
    const fix = seedFullReady(makePlaceId("no-db-writes"));
    const before = snapshotDb();
    const response = await statusRequest(fix.lead.id, fix.draft.id);
    expect(response.status).toBe(200);
    const after = snapshotDb();
    expect(after).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("N. no transport attempt is ever made (all gates may run; nothing sends)", async () => {
    const ready = seedFullReady(makePlaceId("transport-ready"));
    const blocked = seedFullReady(makePlaceId("transport-blocked"), {
      outreachApproval: false,
    });
    await statusRequest(ready.lead.id, ready.draft.id);
    await statusRequest(blocked.lead.id, blocked.draft.id);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendRowCount()).toBe(0);
  });

  it("O. the response contains no API key, secret, or from address", async () => {
    const fix = seedFullReady(makePlaceId("secret-hygiene"));
    const response = await statusRequest(fix.lead.id, fix.draft.id);
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).not.toContain(FROM_EMAIL);
    expect(raw).not.toContain("Bearer");
    expect(raw).not.toContain("Authorization");
    expect(raw).not.toContain("fromEmail");
    expect(raw).not.toContain("resendApiKey");
    expect(raw).not.toContain("authorizationHeader");
  });

  it("the client cannot override recipient, subject, body, provider, hash, version or deployment", async () => {
    const fix = seedFullReady(makePlaceId("no-override"));
    const token = await createSessionToken("admin");
    const request = new Request(
      `http://localhost/api/admin/outreach/send-status?prospectId=${encodeURIComponent(
        fix.lead.id,
      )}&draftId=${encodeURIComponent(fix.draft.id)}` +
        "&recipient=attacker@evil.test&to=attacker@evil.test" +
        "&subject=hacked&body=hacked&fromEmail=attacker@evil.test" +
        "&provider=sendgrid&providerId=sendgrid" +
        "&contentHash=deadbeef&hash=deadbeef" +
        "&websiteVersionId=v999&website=v999" +
        "&deploymentUrl=https://evil.example&bulk=true",
      {
        method: "GET",
        headers: {
          host: "localhost",
          cookie: `aicf_session=${encodeURIComponent(token)}`,
        },
      },
    );
    const response = await GET(request);
    const body = (await response.json()) as {
      recipientEmail: string;
      draft: { subject: string; body: string; contentHash: string };
      websiteVersion: { id: string };
      provider: { id: string };
    };
    expect(body.recipientEmail).toBe(CONTACT_EMAIL);
    expect(body.draft.subject).toBe(SAFE_SUBJECT);
    expect(body.draft.body).toBe(SAFE_BODY);
    expect(body.draft.contentHash).toBe(fix.draft.contentHash);
    expect(body.websiteVersion.id).toBe(fix.version.projectId);
    expect(body.provider.id).toBe("resend");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("P. GET on send-status can never mutate state and exports no mutating methods", async () => {
    const mod = (await import("@/app/api/admin/outreach/send-status/route")) as Record<
      string,
      unknown
    >;
    expect(typeof mod.GET).toBe("function");
    expect(mod.POST).toBeUndefined();
    expect(mod.PUT).toBeUndefined();
    expect(mod.PATCH).toBeUndefined();
    expect(mod.DELETE).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});