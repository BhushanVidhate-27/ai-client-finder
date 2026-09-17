/**
 * GET /api/admin/outreach/send-status — read-only safety preview tests.
 *
 * The preview endpoint must be a pure reader: it evaluates Agent 8 / Agent 10
 * side-effect free, writes nothing (no send authorization, no rows, no activity),
 * never contacts the provider, and exposes no secrets. It exists only to drive
 * the admin confirmation UI; the send itself still requires the authenticated
 * POST mutation with confirm: true.
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
const FAKE_KEY = "re_1234567890abcdef";
const FROM_EMAIL = "hello@example.com";

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
  options: { email?: string; outreachApproval?: boolean } = {},
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
    status: "running",
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
    artifactHash: "artifact-x",
  });
  promoteWebsiteVersion(version.projectId);
  createDeploymentApproval({
    leadId: lead.id,
    websiteVersionId: version.projectId,
    artifactHash: "artifact-x",
    createdBy: "user-1",
  });

  let deployment = createDeploymentRecord({
    websiteProjectId: version.websiteProjectId!,
    leadId: lead.id,
    websiteVersionId: version.projectId,
    version: version.version,
    provider: "mock",
    artifactHash: "artifact-x",
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
) {
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

describe("Outreach send-status — read-only safety preview", () => {
  it("a fully ready prospect reports ready with Safe-gate summary and no side effects", async () => {
    const placeId = makePlaceId("ready");
    const fix = seedFullReady(placeId);
    const response = await statusRequest(fix.lead.id, fix.draft.id);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.ready).toBe(true);
    expect(body.alreadySent).toBe(false);
    expect(body.agent8.decision).toBe("SEND");
    expect(body.agent10.decision).toBe("TRANSPORT_READY");
    expect(body.provider).toMatchObject({ id: "resend", configured: true });
    expect(body.prospect.businessName).toBe(`${placeId} biz`);
    expect(body.recipientEmail).toBe(CONTACT_EMAIL);
    expect(body.draft.subject).toBe(SAFE_SUBJECT);
    expect(body.approval.valid).toBe(true);

    expect(sendRowCount()).toBe(0);
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

  it("a missing approval reports not-ready with a safe blocked reason", async () => {
    const fix = seedFullReady(makePlaceId("not-approved"), { outreachApproval: false });
    const response = await statusRequest(fix.lead.id, fix.draft.id);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ready).toBe(false);
    expect(body.blockedReason).toBeTruthy();
    expect(sendRowCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an opt-out reports not-ready and never authorizes anything", async () => {
    const fix = seedFullReady(makePlaceId("optout"));
    recordOutreachOptOut(fix.lead.id, "unsubscribe", "test");
    const response = await statusRequest(fix.lead.id, fix.draft.id);
    const body = await response.json();
    expect(body.ready).toBe(false);
    expect(body.optOut).toBe(true);
    expect(sendRowCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("evaluating a preview never records a send authorization even for a ready prospect", async () => {
    const fix = seedFullReady(makePlaceId("read-only"));
    for (let i = 0; i < 3; i += 1) {
      const response = await statusRequest(fix.lead.id, fix.draft.id);
      expect(response.status).toBe(200);
    }
    expect(sendRowCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the response contains no API key or secret", async () => {
    const fix = seedFullReady(makePlaceId("secret-hygiene"));
    const response = await statusRequest(fix.lead.id, fix.draft.id);
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).not.toContain("Bearer");
  });

  it("GET on send-status can never send and exports no mutating methods", async () => {
    const mod = (await import("@/app/api/admin/outreach/send-status/route")) as Record<
      string,
      unknown
    >;
    expect(typeof mod.GET).toBe("function");
    expect(mod.POST).toBeUndefined();
    expect(mod.PUT).toBeUndefined();
    expect(mod.DELETE).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});