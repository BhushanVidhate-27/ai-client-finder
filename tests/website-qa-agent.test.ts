import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { createWebsiteQaAgent } from "@/lib/website-qa/agent";
import { runQaAudit } from "@/lib/website-qa/rules";
import { applyFixes, planFixes } from "@/lib/website-qa/fixes";
import type { QaReferences, QaResult } from "@/lib/website-qa/types";
import type { QaAuditInput } from "@/lib/website-qa/types";
import type { WorkspaceFileWithContent } from "@/lib/website-coding/workspace";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  WorkspacePathError,
  workspaceDir,
  writeWorkspaceFiles,
} from "@/lib/website-coding/workspace";
import { buildWorkspace, validateWorkspaceReadOnly } from "@/lib/website-coding/build";
import type { AgentContext } from "@/lib/agents/types";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import type { WebsiteResearch } from "@/lib/lead-research";
import { makeLead, makeResearch } from "./helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function testContact(overrides: Partial<ContactDiscovery> = {}): ContactDiscovery {
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

type FileSpec = Array<{ path: string; content: string }>;

const VIEWPORT =
  '<meta name="viewport" content="width=device-width, initial-scale=1" />';

function pageShell(inner: string, title: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8" />',
    VIEWPORT,
    `<title>${title}</title>`,
    '<link rel="stylesheet" href="styles.css" />',
    "</head>",
    "<body>",
    inner,
    '<script src="script.js"></script>',
    "</body>",
    "</html>",
  ].join("\n");
}

const CONTACT_PAGE = pageShell(
  '<main class="content"><h1>Contact Us</h1><p><a href="/">Home</a></p></main>',
  "Contact Acme Plumbing",
);

const CLEAN_BODY = [
  '<nav aria-label="Main">',
  '<a href="/contact.html">Contact</a>',
  "</nav>",
  '<main class="content">',
  "<h1>Acme Plumbing</h1>",
  "<p>Acme Plumbing provides trusted services in Nowhere.</p>",
  '<ul>',
  '<li class="feature-list__item"><h4>Repairs</h4></li>',
  "</ul>",
  '<section id="contact">',
  "<h2>Contact</h2>",
  "<address>1 Main St</address>",
  '<a href="mailto:office@acme.test">Email us</a>',
  '<a href="tel:+1 555 0100">Call us</a>',
  "</section>",
  "</main>",
].join("\n");

function cleanSite(projectId: string): FileSpec {
  return [
    {
      path: "index.html",
      content: pageShell(CLEAN_BODY, "Acme Plumbing"),
    },
    {
      path: "contact.html",
      content: CONTACT_PAGE,
    },
    {
      path: "styles.css",
      content: ".content{max-width:60rem;margin:0 auto;}",
    },
    {
      path: "script.js",
      content: 'document.documentElement.dataset.ready = "true";',
    },
    {
      path: "package.json",
      content: JSON.stringify(
        { name: projectId, version: "1.0.0", private: true },
        null,
        2,
      ),
    },
  ];
}

const DIRTY_BODY = [
  '<nav aria-label="Main">',
  '<a href="/contact.html">Contact</a>',
  "</nav>",
  '<main class="content">',
  "<h1>Acme Plumbing</h1>",
  "<p>Lorem ipsum dolor sit amet.</p>",
  "<p>We offer a full range of quality options.</p>",
  '<figure><img src="photo.jpg" /></figure>',
  '<article class="card"><h3>Roofing</h3><p>Some details.</p></article>',
  '<blockquote>"Five stars!"</blockquote>',
  "<ul>",
  '<li><a href="mailto:sales@fake.test">Sales</a></li>',
  '<li><a href="tel:+1 555 0111">Emergency line</a></li>',
  "</ul>",
  "</main>",
].join("\n");

function dirtySite(projectId: string): FileSpec {
  const base = cleanSite(projectId);
  return [
    {
      path: "index.html",
      content: pageShell(DIRTY_BODY, "Acme Plumbing").replace(
        `<meta charset="UTF-8" />\n${VIEWPORT}`,
        '<meta charset="UTF-8" />',
      ),
    },
    ...base.filter((f) => f.path !== "index.html"),
  ];
}

function toWorkspaceFiles(files: FileSpec): WorkspaceFileWithContent[] {
  return files.map((f) => ({
    path: f.path,
    bytes: Buffer.byteLength(f.content, "utf8"),
    content: f.content,
  }));
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function refsFor(overrides: Partial<QaReferences> = {}): QaReferences {
  return {
    projectId: "acme-plumbing",
    lead: makeLead("p1", "Acme Plumbing"),
    research: makeResearch(),
    contact: testContact(),
    ...overrides,
  };
}

function pure(
  files: FileSpec,
  overrides: Partial<QaReferences> = {},
  build: QaAuditInput["build"] = null,
): QaResult {
  return runQaAudit({ files: toWorkspaceFiles(files), refs: refsFor(overrides), build });
}

let tmpRoot: string;
let controller: JobController;

function qaContext(overrides: Partial<QaReferences> = {}): AgentContext {
  return {
    goal: { description: "Audit and fix the website", acceptanceCriteria: [] },
    constraints: [],
    references: refsFor(overrides) as unknown as Record<string, unknown>,
  };
}

async function runQa(overrides: Partial<QaReferences> = {}) {
  const agent = createWebsiteQaAgent();
  return runAgentLoop({
    agent,
    context: qaContext(overrides),
    controller,
  });
}

async function seed(projectId: string, files: FileSpec): Promise<void> {
  await writeWorkspaceFiles(
    projectId,
    files.map((f) => ({ path: f.path, content: f.content })),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function allHtml(projectId: string): Promise<string> {
  return listWorkspaceFiles(projectId).then((entries) =>
    Promise.all(
      entries
        .filter((e) => e.path.endsWith(".html"))
        .map((e) => readWorkspaceFile(projectId, e.path)),
    ).then((contents) => contents.join("\n")),
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Website QA Agent", () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "acf-website-qa-"));
    process.env.WORKSPACES_ROOT = tmpRoot;
    resetDatabase(getDb());
    controller = new JobController("job-website-qa");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.WORKSPACES_ROOT;
  });

  it("1. registers website-qa as a runnable agent with read/write/execute only", () => {
    seedDefaultAgents();
    const def = getAgent("website-qa");
    expect(def).toBeDefined();
    expect(def?.status).toBe("available");
    expect(isAgentRunnable("website-qa")).toBe(true);
    expect(def?.permissions).toEqual(["read", "write", "execute"]);
    expect(listAgents().map((a) => a.id)).toContain("website-qa");
    expect(def?.permissions).not.toContain("deploy");
  });

  it("2. PASSes an already-clean verified site without modifying it", async () => {
    await seed("acme-plumbing", cleanSite("acme-plumbing"));
    await buildWorkspace("acme-plumbing");
    const before = JSON.stringify(await listWorkspaceFiles("acme-plumbing"));

    const result = await runQa({ projectId: "acme-plumbing" });
    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.iteration).toBeLessThanOrEqual(8);

    const last = result.result as { build: { status: string }; qa: QaResult };
    expect(last.qa.status).toBe("PASS");
    expect(last.qa.issues.length).toBe(0);

    const after = JSON.stringify(await listWorkspaceFiles("acme-plumbing"));
    expect(after).toBe(before);

    const verification = result.history.verificationResults.at(-1);
    expect(verification?.passed).toBe(true);
    expect(result.history.actions.at(-1)?.name).toBe("website.validate");
  });

  it("3. writes only inside the isolated workspace directory", async () => {
    await seed("acme-plumbing", cleanSite("acme-plumbing"));
    const result = await runQa({ projectId: "acme-plumbing" });
    expect(result.status).toBe("completed");
    const paths = (await listWorkspaceFiles("acme-plumbing")).map((f) => f.path);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith("..")).toBe(false);
      expect(p.startsWith("/")).toBe(false);
    }
  });

  it("4. auto-fixes a dirty site end to end and verifies the result", async () => {
    await seed("acme-plumbing", dirtySite("acme-plumbing"));
    const result = await runQa({ projectId: "acme-plumbing" });

    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.iteration).toBeLessThanOrEqual(8);

    const names = result.history.actions.map((a) => a.name);
    expect(names).toContain("qa.fix");
    expect(names).toContain("website.build");
    expect(names).toContain("website.validate");
    expect(result.history.actions.at(-1)?.name).toBe("website.validate");

    const last = result.result as { build: { status: string }; qa: QaResult };
    expect(last.build.status).toBe("success");
    expect(last.qa.status).toBe("PASS");
    expect(last.qa.issues.length).toBe(0);

    const html = await allHtml("acme-plumbing");
    expect(html).not.toMatch(/lorem ipsum/i);
    expect(html).not.toContain("sales@fake.test");
    expect(html).not.toContain("tel:+1 555 0111");
    expect(html).not.toContain("Roofing");
    expect(html).not.toContain("Five stars");
    expect(html).not.toMatch(/we offer a full range/i);
    expect(html).toMatch(/alt="Image"/);

    const buildManifest = JSON.parse(
      readFileSync(path.join(workspaceDir("acme-plumbing"), "build.json"), "utf8"),
    );
    expect(buildManifest.status).toBe("success");
  });

  it("5. detects lorem ipsum and placeholder copy and plans a removal fix", () => {
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      `<h1>Acme Plumbing</h1>`,
      `<h1>Acme Plumbing</h1><p>Lorem ipsum dolor sit amet.</p>`,
    );
    const audit = pure(files);
    expect(audit.status).toBe("FAIL");
    const lorem = audit.issues.find((i) => i.description.includes("Lorem ipsum"));
    expect(lorem).toBeDefined();
    expect(lorem?.severity).toBe("high");
    expect(lorem?.fixable).toBe(true);
    expect(lorem?.fixKind).toBe("remove-sentence");

    const fixes = planFixes(audit, toWorkspaceFiles(files));
    const report = applyFixes(toWorkspaceFiles(files), fixes);
    const applied = report.changedFiles.find((f) => f.path === "index.html");
    expect(applied?.content).not.toMatch(/lorem ipsum/i);
  });

  it("6. flags coming-soon / boilerplate copy as a medium fixable issue", () => {
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      `<h1>Acme Plumbing</h1>`,
      `<h1>Acme Plumbing</h1><p>Website coming soon.</p>`,
    );
    const audit = pure(files);
    const boilerplate = audit.issues.find((i) =>
      i.description.includes("Boilerplate"),
    );
    expect(boilerplate).toBeDefined();
    expect(boilerplate?.severity).toBe("medium");
    expect(boilerplate?.fixable).toBe(true);
  });

  it("7. removes testimonials that are not present in the verified evidence", () => {
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      "<h1>Acme Plumbing</h1>",
      '<h1>Acme Plumbing</h1><blockquote>"We were thrilled!"</blockquote>',
    );
    const audit = pure(files);
    const testimonial = audit.issues.find((i) =>
      i.description.includes("Testimonial"),
    );
    expect(testimonial).toBeDefined();
    expect(testimonial?.fixKind).toBe("remove-testimonial");

    const report = applyFixes(toWorkspaceFiles(files), [      { issueId: testimonial!.id, kind: "remove-testimonial", file: "index.html", target: testimonial!.evidence },
    ]);
    const index = report.changedFiles.find((f) => f.path === "index.html");
    expect(index?.content).not.toContain("We were thrilled");
  });

  it("8. a testimonial from the verified evidence is allowed", () => {
    const files = cleanSite("acme-plumbing");
    const quote = makeResearch().businessSummary;
    const withQuote = files[0].content.replace(
      "<h1>Acme Plumbing</h1>",
      `<h1>Acme Plumbing</h1><blockquote>"${quote}"</blockquote>`,
    );
    files[0].content = withQuote;
    const audit = pure(files);
    const testimonial = audit.issues.find((i) =>
      i.description.includes("Testimonial"),
    );
    expect(testimonial).toBeUndefined();
  });

  it("9. removes fabricated service cards that have no verified service", () => {
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      '<li class="feature-list__item"><h4>Repairs</h4></li>',
      '<article class="card"><h3>Roofing</h3><p>Full roof work.</p></article>',
    );
    const audit = pure(files);
    const fabricated = audit.issues.find((i) =>
      i.description.includes('Service "Roofing"'),
    );
    expect(fabricated).toBeDefined();
    expect(fabricated?.severity).toBe("high");
    expect(fabricated?.fixKind).toBe("remove-service-card");

    const report = applyFixes(toWorkspaceFiles(files), [      { issueId: fabricated!.id, kind: "remove-service-card", file: "index.html", target: fabricated!.evidence },
    ]);
    const index = report.changedFiles.find((f) => f.path === "index.html");
    expect(index?.content).not.toContain("Roofing");
  });

  it("10. removes unverified contact details from the contact section", () => {
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      '<a href="mailto:office@acme.test">Email us</a>',
      '<a href="mailto:sales@fake.test">Sales</a>',
    );
    const audit = pure(files);
    const email = audit.issues.find((i) =>
      i.description.includes("sales@fake.test"),
    );
    expect(email).toBeDefined();
    expect(email?.severity).toBe("critical");
    expect(email?.fixKind).toBe("remove-contact-item");
  });

  it("11. rejects a fake-looking 555 phone when no phone is verified", () => {
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      '<a href="tel:+1 555 0100">Call us</a>',
      '<a href="tel:+1 555 0199">Call us</a>',
    );
    const audit = pure(files, {
      contact: testContact({ phone: null }),
    });
    const phone = audit.issues.find((i) => i.category === "contact");
    expect(phone).toBeDefined();
    expect(phone?.severity).toBe("critical");
  });

  it("12. allows verified phone and email from the evidence (CASE C)", () => {
    const audit = pure(cleanSite("acme-plumbing"));
    const contactIssue = audit.issues.find((i) => i.category === "contact");
    expect(contactIssue).toBeUndefined();
    expect(audit.status).toBe("PASS");
  });

  it("13. flags a javascript: URL as critical and unsafe (CASE E)", () => {
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      "</nav>",
      '<a href="javascript:alert(1)">Surprise</a></nav>',
    );
    const audit = pure(files);
    const js = audit.issues.find((i) => i.description.includes("javascript:"));
    expect(js).toBeDefined();
    expect(js?.severity).toBe("critical");
    expect(js?.fixKind).toBe("remove-element");
  });

  it("14. flags a protocol-relative URL as critical and unsafe (CASE F)", () => {
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      "</nav>",
      '<a href="//example.com">Extern</a></nav>',
    );
    const audit = pure(files);
    const proto = audit.issues.find((i) =>
      i.description.includes("Protocol-relative"),
    );
    expect(proto).toBeDefined();
    expect(proto?.severity).toBe("critical");
  });

  it("15. flags path-traversal references as critical", () => {
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      "</nav>",
      '<a href="../../etc/passwd">Nope</a></nav>',
    );
    const audit = pure(files);
    const traversal = audit.issues.find((i) =>
      i.description.includes("Path traversal"),
    );
    expect(traversal).toBeDefined();
    expect(traversal?.severity).toBe("critical");
  });

  it("16. flags a broken internal link with no target page (CASE G)", () => {
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      '<a href="/contact.html">Contact</a>',
      '<a href="/services">Services</a>',
    );
    const audit = pure(files);
    const broken = audit.issues.find((i) =>
      i.description.includes('/services"'),
    );
    expect(broken).toBeDefined();
    expect(broken?.severity).toBe("high");
    expect(broken?.fixable).toBe(false);
  });

  it("17. resizes a fixable broken link to the unique existing page", () => {
    const files = cleanSite("acme-plumbing");
    // Add an about page and a slightly-wrong link to it.
    files.push({
      path: "about.html",
      content: pageShell(
        '<main class="content"><h1>About Acme</h1><p><a href="/">Home</a></p></main>',
        "About Acme Plumbing",
      ),
    });
    files[0].content = files[0].content.replace(
      '<a href="/contact.html">Contact</a>',
      '<a href="/about">About</a>',
    );
    const audit = pure(files);
    const broken = audit.issues.find((i) =>
      i.description.includes("/about"),
    );
    expect(broken).toBeUndefined();
  });

  it("18. adds a missing alt attribute and injects a viewport (both fixable)", () => {
    // Missing alt only.
    const noAlt = cleanSite("acme-plumbing");
    noAlt[0].content = noAlt[0].content.replace(
      "<h1>Acme Plumbing</h1>",
      '<img src="photo.jpg" /><h1>Acme Plumbing</h1>',
    );
    const altAudit = pure(noAlt);
    const alt = altAudit.issues.find((i) => i.description.includes("alt"));
    expect(alt).toBeDefined();
    expect(alt?.fixKind).toBe("add-alt");

    const altReport = applyFixes(toWorkspaceFiles(noAlt), [      { issueId: alt!.id, kind: "add-alt", file: alt!.file!, target: alt!.evidence },
    ]);
    const withAlt = altReport.changedFiles.find((f) => f.path === "index.html");
    expect(withAlt?.content).toMatch(/alt="Image"/);

    // Missing viewport on every page.
    const noViewport = cleanSite("acme-plumbing");
    for (const f of noViewport) {
      f.content = f.content.replace(VIEWPORT, "");
    }
    const vpAudit = pure(noViewport);
    const vpIssues = vpAudit.issues.filter((i) =>
      i.description.includes("viewport"),
    );
    expect(vpIssues.length).toBeGreaterThanOrEqual(1);
    expect(vpIssues[0].fixable).toBe(true);
    expect(vpIssues[0].fixKind).toBe("add-viewport");

    const vpReport = applyFixes(toWorkspaceFiles(noViewport), vpIssues.map((i) => ({
      issueId: i.id,
      kind: "add-viewport",
      file: i.file!,
      target: "<head>",
    })));
    for (const f of vpReport.changedFiles) {
      expect(f.content).toMatch(/name="viewport"/);
    }
  });

  it("19. rejects site copy that asserts a specialization with no support (CASE A)", () => {
    const research: WebsiteResearch = {
      ...makeResearch(),
      services: [],
      targetAudience: "",
    };
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      "<p>Acme Plumbing provides trusted services in Nowhere.</p>",
      "<p>We specialize in weddings.</p>",
    );
    const audit = pure(files, {
      research,
      targetNiche: "wedding photographer",
    });
    const niche = audit.issues.find(
      (i) => i.category === "business-safety" && i.severity === "critical",
    );
    expect(niche).toBeDefined();
    expect(niche?.severity).toBe("critical");
    expect(audit.status).toBe("FAIL");
  });

  it("20. allows generic neutral copy when services are unknown (CASE H)", () => {
    const research: WebsiteResearch = {
      ...makeResearch(),
      services: [],
      targetAudience: "",
    };
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      '<li class="feature-list__item"><h4>Repairs</h4></li>',
      "",
    );
    const audit = pure(files, { research });
    const safety = audit.issues.find((i) => i.category === "business-safety");
    expect(safety).toBeUndefined();
  });

  it("21. escalates when the site states something explicitly marked as unknown", () => {
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      "<p>Acme Plumbing provides trusted services in Nowhere.</p>",
      "<p>We specialize in wedding photography.</p>",
    );
    const audit = pure(files, {
      unknowns: ["Wedding photography services are unknown."],
    });
    const unknownStated = audit.issues.find((i) =>
      i.description.includes("unknown"),
    );
    expect(unknownStated).toBeDefined();
    expect(unknownStated?.severity).toBe("critical");
  });

  it("22. flags unsupported years / pricing / awards claims as fixable", () => {
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      "<p>Acme Plumbing provides trusted services in Nowhere.</p>",
      "<p>We are rated 5 out of 5 from 120 reviews. Starting at $99 per visit. Award-winning service.</p>",
    );
    const audit = pure(files);
    const reviews = audit.issues.find((i) => i.description.includes("reviews"));
    const pricing = audit.issues.find((i) => i.description.includes("Pricing"));
    const awards = audit.issues.find((i) =>
      i.description.includes("Award"),
    );
    expect(reviews?.fixable).toBe(true);
    expect(pricing?.fixable).toBe(true);
    expect(awards?.fixable).toBe(true);
  });

  it("23. reports missing required files as high and non-fixable", () => {
    const files = cleanSite("acme-plumbing").filter(
      (f) => f.path !== "script.js",
    );
    const audit = pure(files, { requiredFiles: ["index.html", "script.js"] });
    const missing = audit.issues.find((i) =>
      i.description.includes("script.js"),
    );
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe("high");
    expect(missing?.fixable).toBe(false);
  });

  it("24. fails safely at the iteration bound when only non-fixable issues remain", async () => {
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      ".content{max-width:60rem;margin:0 auto;}",
      ".content{max-width:60rem;margin:0 auto;}",
    );
    // Introduce a fixed-width (non-fixable) layout.
    files.find((f) => f.path === "styles.css")!.content += ".jumbo{width:1040px;}";
    await seed("acme-plumbing", files);
    await buildWorkspace("acme-plumbing");

    const result = await runQa({ projectId: "acme-plumbing" });
    expect(result.status).toBe("failed");
    expect(result.error).toBe(MAX_ITERATIONS_REASON);
    expect(result.iteration).toBe(8);
  });

  it("25. never marks a site PASS merely because it builds", async () => {
    // The site builds fine, but it keeps a non-fixable accessibility defect
    // (empty link with no accessible name), so QA can never pass.
    const files = cleanSite("acme-plumbing");
    files[0].content = files[0].content.replace(
      "</nav>",
      '<a href="#top"></a></nav>',
    );
    await seed("acme-plumbing", files);
    const validation = await validateWorkspaceReadOnly("acme-plumbing");
    expect(validation.status).toBe("success");

    const result = await runQa({ projectId: "acme-plumbing" });
    expect(result.status).toBe("failed");
    expect(result.error).toBe(MAX_ITERATIONS_REASON);
    expect(result.history.verificationResults.some((v) => v.passed)).toBe(false);
  });

  it("26. verification gate requires a durable success build manifest", async () => {
    // Workspace is content-valid, but no build.json was written.
    await seed("acme-plumbing", cleanSite("acme-plumbing"));
    const result = await runQa({ projectId: "acme-plumbing" });
    expect(result.status).toBe("completed");
    const actions = result.history.actions.map((a) => a.name);
    expect(actions).toContain("website.build");
    expect(result.history.actions.at(-1)?.name).toBe("website.validate");
    const manifest = JSON.parse(
      readFileSync(path.join(workspaceDir("acme-plumbing"), "build.json"), "utf8"),
    );
    expect(manifest.status).toBe("success");
  });

  it("27. paused runs wait for resume before doing any work", async () => {
    await seed("acme-plumbing", dirtySite("acme-plumbing"));
    controller.requestPause();
    let started = 0;
    let completed = 0;

    const job = runAgentLoop({
      agent: createWebsiteQaAgent(),
      context: qaContext({ projectId: "acme-plumbing" }),
      controller,
      onMilestone: (milestone) => {
        if (milestone === "iteration_started") started += 1;
        if (milestone === "completed") completed += 1;
      },
    });

    await sleep(60);
    expect(started).toBe(0);
    expect(completed).toBe(0);

    controller.resume();
    const result = await job;
    expect(result.status).toBe("completed");
    expect(started).toBeGreaterThan(0);
    expect(completed).toBe(1);
  });

  it("28. stopped runs stop immediately without further work", async () => {
    controller.requestStop();
    const result = await runQa({ projectId: "acme-plumbing" });
    expect(result.status).toBe("stopped");
    expect(result.error).toMatch(/stopped/);
    expect(result.history.actions.length).toBe(0);
  });

  it("29. no deploy permission and no shell execution are available", async () => {
    const agent = createWebsiteQaAgent();
    const toolbox = new AgentToolbox(agent.tools ?? [], agent.permissions);
    await expect(
      toolbox.run(
        { name: "workspace.create", permission: "deploy", input: { projectId: "x" } },
        qaContext(),
      ),
    ).rejects.toThrow(PermissionError);
    await expect(
      toolbox.run(
        { name: "run-shell", permission: "execute", input: { command: "rm -rf /" } },
        qaContext(),
      ),
    ).rejects.toThrow(ToolNotFoundError);
  });

  it("30. hostile paths are rejected at the workspace layer", async () => {
    const agent = createWebsiteQaAgent();
    const readTool = agent.tools?.find((t) => t.name === "workspace.read");
    expect(readTool).toBeDefined();
    await expect(
      readTool!.execute!(
        { projectId: "acme-plumbing", path: "../.env.local" },
        qaContext(),
      ),
    ).rejects.toThrow(WorkspacePathError);
    await expect(
      readTool!.execute!(
        { projectId: "acme-plumbing", path: "/tmp/evil.conf" },
        qaContext(),
      ),
    ).rejects.toThrow(WorkspacePathError);
  });

  it("31. a plan requires references before running", async () => {
    const agent = createWebsiteQaAgent();
    const emptyCtx: AgentContext = {
      goal: { description: "Audit and fix the website", acceptanceCriteria: [] },
      constraints: [],
    };
    await expect(
      runAgentLoop({ agent, context: emptyCtx, controller }),
    ).rejects.toThrow(/references.lead/);
  });

  it("32. pure QA is deterministic across identical runs", () => {
    const first = pure(dirtySite("acme-plumbing"));
    const second = pure(dirtySite("acme-plumbing"));
    expect(second.status).toBe(first.status);
    expect(second.issues.map((i) => i.description)).toEqual(
      first.issues.map((i) => i.description),
    );
    expect(second.checks.map((c) => [c.id, c.passed])).toEqual(
      first.checks.map((c) => [c.id, c.passed]),
    );
  });

  it("33. build validator agrees the clean workspace is valid before QA", async () => {
    const files = cleanSite("acme-plumbing");
    await seed("acme-plumbing", files);
    const validation = await validateWorkspaceReadOnly("acme-plumbing");
    expect(validation.status).toBe("success");
  });
});