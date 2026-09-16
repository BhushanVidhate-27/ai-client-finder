/**
 * Website Coding Agent — the first real, runnable agent.
 *
 * Takes a qualified prospect and its research/specification, creates an
 * isolated workspace under `workspaces/<project-id>/`, generates a real
 * multi-page static website from deterministic render, builds and validates
 * it, and fixes issues iteratively up to 8 iterations.
 *
 * Every action is permission-gated and confined to the workspace. No shell
 * commands are executed and no application directories outside the workspace
 * are ever written to.
 */

import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentContext,
  AgentLoopState,
  AgentObservation,
  AgentAction,
  AgentVerification,
  AgentVerificationCheck,
  AgentStep,
  AgentTask,
} from "@/lib/agents/types";
import { DEFAULT_MAX_ITERATIONS } from "@/lib/agents/planner";
import type { QualifiedLead } from "@/lib/lead-qualification";
import type { WebsiteResearch } from "@/lib/lead-research";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import type { WebsiteBlueprint } from "@/lib/website-project";
import { renderSiteSource, resolveProjectId } from "./site-render";
import type { CoderProspectInput, RenderedSite } from "./site-render";
import { buildWorkspace, validateWorkspaceReadOnly } from "./build";
import {
  ensureWorkspace,
  deleteWorkspace,
  listWorkspaceFiles,
  readWorkspaceFile,
  getWorkspaceFilesWithContent,
  writeWorkspaceFiles,
  workspaceDir,
} from "./workspace";

// ---------------------------------------------------------------------------
// Reference shapes
// ---------------------------------------------------------------------------

interface CoderReferences {
  lead: QualifiedLead;
  research: WebsiteResearch;
  contact?: ContactDiscovery | null;
  blueprint?: WebsiteBlueprint | null;
  projectId?: string;
  requiredFiles?: string[];
}

function referencesAreValid(refs: unknown): refs is CoderReferences {
  if (typeof refs !== "object" || refs === null) return false;
  const r = refs as Record<string, unknown>;
  return (
    typeof r.lead === "object" &&
    r.lead !== null &&
    typeof r.research === "object" &&
    r.research !== null
  );
}

// ---------------------------------------------------------------------------
// Inspection state
// ---------------------------------------------------------------------------

interface InspectionData {
  projectId: string;
  workspaceDir: string;
  rendered: RenderedSite | null;
  workspaceExists: boolean;
  files: string[];
  missingFiles: string[];
  buildStatus: "success" | "error" | "not_run";
  buildErrors: unknown[] | null;
  hasRendered: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasExternalAbsoluteLink(html: string): boolean {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const hrefs = withoutComments.match(/href\s*=\s*("[^"]*"|'[^']*')/gi) ?? [];
  for (const href of hrefs) {
    const value = (
      href.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") ||
      ""
    ).trim();
    if (!value) continue;
    if (
      /^javascript:/i.test(value) ||
      /^data:/i.test(value) ||
      value.startsWith("//")
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Steps / actions / constants
// ---------------------------------------------------------------------------

const STEPS: AgentStep[] = [
  { id: "create-workspace", label: "Create workspace" },
  { id: "generate-files", label: "Generate site files" },
  { id: "build", label: "Build and validate" },
  { id: "verify-and-finish", label: "Verify and finish" },
];

const ALLOWED_ACTIONS = [
  "workspace.create",
  "workspace.list",
  "workspace.read",
  "workspace.write",
  "workspace.delete",
  "website.build",
  "website.validate",
];

// ---------------------------------------------------------------------------
// Injectable dependencies (for testing)
// ---------------------------------------------------------------------------

export interface WebsiteCodingDeps {
  render?: (input: CoderProspectInput, projectId: string) => RenderedSite;
  resolveProjectId?: typeof resolveProjectId;
  build?: typeof buildWorkspace;
  validate?: typeof validateWorkspaceReadOnly;
}

const DEFAULT_DEPS: Required<WebsiteCodingDeps> = {
  render: renderSiteSource,
  resolveProjectId,
  build: buildWorkspace,
  validate: validateWorkspaceReadOnly,
};

// ---------------------------------------------------------------------------
// Agent factory
// ---------------------------------------------------------------------------

function makeTask(): AgentTask {
  return {
    objective: "Create a verified website workspace from approved research",
    constraints: [
      "Only write inside the workspace directory",
      "Never use arbitrary shell commands",
      "Never fabricate information",
      "Maximum 8 iterations",
    ],
    acceptanceCriteria: [
      "Build succeeds with no errors",
      "Workspace exists with all required files",
      "Source files match deterministic render output",
      "Contact information is verified",
      "No lorem ipsum or broken links",
    ],
    steps: [...STEPS],
    allowedActions: [...ALLOWED_ACTIONS],
    verificationRequirements: [
      "Workspace created and files generated only inside the workspace",
      "Build succeeds with no errors",
      "Generated files match deterministic render of approved content",
      "Required files exist and are not corrupted",
      "No fabricated contact information",
      "No lorem ipsum or incomplete content",
    ],
    maxIterations: DEFAULT_MAX_ITERATIONS,
  };
}

function assertValidReferences(references: unknown): void {
  if (!referencesAreValid(references)) {
    throw new Error(
      "references.lead and references.research are required to build a website.",
    );
  }
}

export function createWebsiteCodingAgent(
  deps?: WebsiteCodingDeps,
): Agent {
  const d: Required<WebsiteCodingDeps> = { ...DEFAULT_DEPS, ...deps };

  // -----------------------------------------------------------------------
  // Inspect
  // -----------------------------------------------------------------------

  async function inspectImpl(
    context: AgentContext,
    state: AgentLoopState,
  ): Promise<AgentObservation> {
    const refs = context.references as CoderReferences | undefined;
    const projectId = d.resolveProjectId({
      explicit: refs?.projectId,
      lead: refs?.lead,
    });
    const wsDir = workspaceDir(projectId);

    let workspaceExists = false;
    let files: string[] = [];
    try {
      const entries = await listWorkspaceFiles(projectId);
      workspaceExists = true;
      files = entries.map((entry) => entry.path);
    } catch {
      workspaceExists = false;
    }

    let rendered: RenderedSite | null = null;
    if (refs?.lead && refs?.research) {
      try {
        rendered = d.render(
          {
            lead: refs.lead,
            research: refs.research,
            contact: refs.contact ?? null,
            blueprint: refs.blueprint ?? null,
          },
          projectId,
        );
      } catch {
        rendered = null;
      }
    }

    const requiredSet = new Set([
      "index.html",
      "styles.css",
      "script.js",
      "package.json",
      ...(rendered?.requiredFiles ?? []),
    ]);
    const existingSet = new Set(files);
    const missingFiles = [...requiredSet].filter((f) => !existingSet.has(f));

    let buildStatus: InspectionData["buildStatus"] = "not_run";
    let buildErrors: unknown[] | null = null;

    try {
      const raw = await readWorkspaceFile(projectId, "build.json");
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      buildStatus = manifest.status === "success" ? "success" : "error";
    } catch {
      // build.json absent
    }

    try {
      const raw = await readWorkspaceFile(projectId, "build-errors.json");
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      buildErrors = Array.isArray(manifest.errors) ? manifest.errors : null;
      if (buildStatus === "not_run") buildStatus = "error";
    } catch {
      // build-errors.json absent
    }

    return {
      id: randomUUID(),
      iteration: state.iteration,
      description: workspaceExists
        ? `Workspace present with ${files.length} files; build ${buildStatus}.`
        : "Workspace not found.",
      state: {
        projectId,
        workspaceDir: wsDir,
        workspaceExists,
        rendered,
        files,
        missingFiles,
        buildStatus,
        buildErrors,
        hasRendered: rendered !== null,
      } satisfies InspectionData,
      at: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // Decide
  // -----------------------------------------------------------------------

  function decideImpl(
    _context: AgentContext,
    state: AgentLoopState,
    observation: AgentObservation,
  ): AgentAction {
    const ins = observation.state as unknown as InspectionData;
    const lastActionName =
      state.actions[state.actions.length - 1]?.name ?? null;

    if (!ins.workspaceExists) {
      return {
        name: "workspace.create",
        permission: "write",
        input: { projectId: ins.projectId },
        description: "Create workspace directory",
        completesStep: true,
        nextStepId: "generate-files",
      };
    }

    if (!ins.rendered) {
      return {
        name: "workspace.create",
        permission: "write",
        input: { projectId: ins.projectId },
        description: "Create workspace for a project with invalid references",
        completesStep: false,
      };
    }

    if (
      lastActionName === "workspace.create" ||
      lastActionName === "workspace.list" ||
      lastActionName === null
    ) {
      return {
        name: "workspace.write",
        permission: "write",
        input: { projectId: ins.projectId, files: ins.rendered.files },
        description: "Generate site files",
        completesStep: true,
        nextStepId: "build",
      };
    }

    if (lastActionName === "workspace.write") {
      return {
        name: "website.build",
        permission: "execute",
        input: {
          projectId: ins.projectId,
          requiredFiles: ins.rendered.requiredFiles,
        },
        description: "Build the website",
        completesStep: false,
      };
    }

    if (lastActionName === "website.build") {
      if (ins.buildStatus === "success") {
        return {
          name: "website.validate",
          permission: "read",
          input: {
            projectId: ins.projectId,
            requiredFiles: ins.rendered.requiredFiles,
          },
          description: "Run final site validation",
          completesStep: true,
          nextStepId: "verify-and-finish",
        };
      }
      return {
        name: "workspace.write",
        permission: "write",
        input: { projectId: ins.projectId, files: ins.rendered.files },
        description: "Fix build errors by rewriting site files",
        completesStep: false,
      };
    }

    if (lastActionName === "website.validate") {
      if (ins.buildStatus === "error") {
        return {
          name: "workspace.write",
          permission: "write",
          input: { projectId: ins.projectId, files: ins.rendered.files },
          description: "Fix issues found by validation",
          completesStep: false,
        };
      }
      return {
        name: "website.validate",
        permission: "read",
        input: {
          projectId: ins.projectId,
          requiredFiles: ins.rendered.requiredFiles,
        },
        description: "Re-run validation",
        completesStep: true,
        nextStepId: "verify-and-finish",
      };
    }

    return {
      name: "workspace.create",
      permission: "write",
      input: { projectId: ins.projectId },
      description: "Create workspace",
      completesStep: true,
      nextStepId: "generate-files",
    };
  }

  // -----------------------------------------------------------------------
  // Agent object
  // -----------------------------------------------------------------------

  const agent: Agent = {
    id: "website-coder",
    name: "Website Coding Agent",
    description:
      "Takes a qualified prospect and research/specification, creates an isolated workspace, generates a real multi-page website, validates it, and fixes issues iteratively.",
    jobType: "website_generation",
    permissions: ["read", "write", "execute"],

    tools: [
      {
        name: "workspace.create",
        description: "Create the project workspace directory.",
        permission: "write",
        execute: async (input) => {
          const { projectId } = (input ?? {}) as { projectId?: string };
          if (typeof projectId !== "string")
            throw new Error("projectId is required.");
          return { projectId, path: await ensureWorkspace(projectId) };
        },
      },
      {
        name: "workspace.list",
        description: "List files in the workspace.",
        permission: "read",
        execute: async (input) => {
          const { projectId } = (input ?? {}) as { projectId?: string };
          if (typeof projectId !== "string")
            throw new Error("projectId is required.");
          return { projectId, files: await listWorkspaceFiles(projectId) };
        },
      },
      {
        name: "workspace.read",
        description: "Read a file inside the workspace.",
        permission: "read",
        execute: async (input) => {
          const { projectId, path: relPath } = (input ?? {}) as {
            projectId?: string;
            path?: string;
          };
          if (typeof projectId !== "string" || typeof relPath !== "string")
            throw new Error("projectId and path are required.");
          return { content: await readWorkspaceFile(projectId, relPath) };
        },
      },
      {
        name: "workspace.write",
        description:
          "Write one or more files inside the workspace. Paths must be relative and safe.",
        permission: "write",
        execute: async (input) => {
          const { projectId, files } = (input ?? {}) as {
            projectId?: string;
            files?: unknown;
          };
          if (typeof projectId !== "string" || !Array.isArray(files))
            throw new Error("projectId and files array are required.");
          const typedFiles: Array<{ path: string; content: string }> = [];
          for (const file of files) {
            if (
              typeof file !== "object" ||
              file === null ||
              typeof (file as Record<string, unknown>).path !== "string" ||
              typeof (file as Record<string, unknown>).content !== "string"
            ) {
              throw new Error(
                "Each file must have path and content strings.",
              );
            }
            typedFiles.push(file as { path: string; content: string });
          }
          return {
            projectId,
            written: await writeWorkspaceFiles(projectId, typedFiles),
          };
        },
      },
      {
        name: "workspace.delete",
        description:
          "Delete the workspace directory. Use only when absolutely necessary.",
        permission: "write",
        execute: async (input) => {
          const { projectId } = (input ?? {}) as { projectId?: string };
          if (typeof projectId !== "string")
            throw new Error("projectId is required.");
          await deleteWorkspace(projectId);
          return { projectId, deleted: true };
        },
      },
      {
        name: "website.build",
        description: "Validate the workspace and record build status.",
        permission: "execute",
        execute: async (input) => {
          const { projectId, requiredFiles } = (input ?? {}) as {
            projectId?: string;
            requiredFiles?: string[];
          };
          if (typeof projectId !== "string")
            throw new Error("projectId is required.");
          return d.build(projectId, requiredFiles);
        },
      },
      {
        name: "website.validate",
        description:
          "Read-only validation of the website workspace (no writes).",
        permission: "read",
        execute: async (input) => {
          const { projectId, requiredFiles } = (input ?? {}) as {
            projectId?: string;
            requiredFiles?: string[];
          };
          if (typeof projectId !== "string")
            throw new Error("projectId is required.");
          return d.validate(projectId, requiredFiles);
        },
      },
    ],

    planner: {
      plan(input: { goal: string; constraints?: string[]; context?: unknown }) {
        assertValidReferences(input.context);
        return makeTask();
      },
    },

    plan(context): AgentTask {
      assertValidReferences(context.references);
      return makeTask();
    },

    inspect: inspectImpl,
    decide: decideImpl,

    // ---------------------------------------------------------------------
    // Verify — completely stateless, re-reads everything fresh
    // ---------------------------------------------------------------------

    async verify(
      context: AgentContext,
      state: AgentLoopState,
      result: { ok: boolean; data?: unknown },
    ): Promise<AgentVerification> {
      const refs = context.references as CoderReferences | undefined;
      const lastAction = state.actions[state.actions.length - 1];
      const isFinalValidate =
        lastAction?.name === "website.validate" && result.ok;

      const projectId = d.resolveProjectId({
        explicit: refs?.projectId,
        lead: refs?.lead,
      });

      // Re-render fresh (stateless, injectable for testing)
      let rendered: RenderedSite | null = null;
      if (refs?.lead && refs?.research) {
        try {
          rendered = d.render(
            {
              lead: refs.lead,
              research: refs.research,
              contact: refs.contact ?? null,
              blueprint: refs.blueprint ?? null,
            },
            projectId,
          );
        } catch {
          rendered = null;
        }
      }

      // Read current workspace state fresh
      let workspaceFiles: Array<{ path: string; content: string }> = [];
      try {
        workspaceFiles = await getWorkspaceFilesWithContent(projectId);
      } catch {
        workspaceFiles = [];
      }
      const workspaceMap = new Map(
        workspaceFiles.map((file) => [file.path, file.content]),
      );
      const workspacePaths = new Set(workspaceFiles.map((file) => file.path));
      const allHtml = workspaceFiles
        .filter((file) => file.path.endsWith(".html"))
        .map((file) => file.content)
        .join("\n");

      const checks: AgentVerificationCheck[] = [];

      // 1. Final validate action succeeded
      checks.push({
        requirement: "Final validate action succeeded",
        passed: isFinalValidate,
        detail: isFinalValidate
          ? undefined
          : "Last action was not a successful website.validate.",
      });

      // 2. Required files present
      const requiredFiles = new Set([
        "index.html",
        "styles.css",
        "script.js",
        "package.json",
        ...(rendered?.requiredFiles ?? []),
      ]);
      const missingFiles = [...requiredFiles].filter(
        (f) => !workspacePaths.has(f),
      );
      checks.push({
        requirement: "Required files present",
        passed: missingFiles.length === 0,
        detail:
          missingFiles.length === 0
            ? undefined
            : `Missing files: ${missingFiles.join(", ")}`,
      });

      // 3. Byte-equality with render
      let contentMatchOk = false;
      if (rendered) {
        contentMatchOk = rendered.files.every(
          (f) => workspaceMap.get(f.path) === f.content,
        );
      }
      checks.push({
        requirement: "Workspace source files match deterministic render",
        passed: contentMatchOk,
        detail: contentMatchOk
          ? undefined
          : "One or more files differ from the expected deterministic render.",
      });

      // 4. No lorem ipsum
      const hasLorem = workspaceFiles.some((file) =>
        /lorem ipsum/i.test(file.content),
      );
      checks.push({
        requirement: "No lorem ipsum or placeholder content",
        passed: !hasLorem,
        detail: hasLorem
          ? "Lipsum or placeholder content detected."
          : undefined,
      });

      // 5. No forbidden absolute external links
      const hasForbiddenLink = workspaceFiles
        .filter((file) => file.path.endsWith(".html"))
        .some((file) => hasExternalAbsoluteLink(file.content));
      checks.push({
        requirement:
          "No absolute external links (javascript:, data:, or protocol-relative)",
        passed: !hasForbiddenLink,
        detail: hasForbiddenLink
          ? "Absolute or executable external links found."
          : undefined,
      });

      // 6. Contact correspondence — mailto/tel present in rendered HTML
      let contactOk = true;
      const contactIssues: string[] = [];
      if (rendered) {
        const contact = rendered.project.contact;
        if (contact.email && !allHtml.includes(`mailto:${contact.email}`)) {
          contactOk = false;
          contactIssues.push(
            "email address missing from rendered HTML",
          );
        }
        if (contact.phone && !allHtml.includes(`tel:${contact.phone}`)) {
          contactOk = false;
          contactIssues.push(
            "phone number missing from rendered HTML",
          );
        }
        if (contact.address && !allHtml.includes(contact.address)) {
          contactOk = false;
          contactIssues.push("address missing from rendered HTML");
        }
      }
      checks.push({
        requirement: "Verified contact information is rendered",
        passed: contactOk,
        detail: contactOk ? undefined : contactIssues.join("; "),
      });

      const passed = checks.every((check) => check.passed);

      return {
        id: randomUUID(),
        iteration: state.iteration,
        passed,
        checks,
        at: new Date().toISOString(),
      };
    },
  };

  return agent;
}
