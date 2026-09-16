import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentAction,
  AgentContext,
  AgentLoopState,
  AgentObservation,
  AgentStep,
  AgentTask,
  AgentVerification,
  AgentVerificationCheck,
  TaskPlanner,
} from "@/lib/agents/types";
import { DEFAULT_MAX_ITERATIONS } from "@/lib/agents/planner";
import { slugify } from "@/lib/website-builder";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFiles,
  deleteWorkspace,
  readBuildManifest,
} from "@/lib/website-coding/workspace";
import {
  buildWorkspace,
  validateWorkspaceReadOnly,
  BASE_REQUIRED_FILES,
} from "@/lib/website-coding/build";
import type { BuildResult } from "@/lib/website-coding/build";
import { readQaWorkspace, auditWorkspace } from "./inspect";
import { planFixes, applyFixes } from "./fixes";
import type { QaFixReport, QaIssue, QaReferences, QaResult } from "./types";

export { BASE_REQUIRED_FILES };

// ---------------------------------------------------------------------------
// Reference helpers
// ---------------------------------------------------------------------------

function resolveProjectId(refs: QaReferences): string {
  if (refs.projectId) return refs.projectId;
  const name = refs.lead?.businessName;
  if (!name || !name.trim()) {
    throw new Error(
      "references.projectId or references.lead.businessName is required.",
    );
  }
  return slugify(name);
}

function referencesAreValid(refs: QaReferences): boolean {
  return Boolean(
    refs.lead ||
      refs.research ||
      (Array.isArray(refs.verifiedFacts) && refs.verifiedFacts.length > 0),
  );
}

// ---------------------------------------------------------------------------
// Inspection state
// ---------------------------------------------------------------------------

interface InspectionData {
  projectId: string;
  workspaceExists: boolean;
  files: string[];
  qa: QaResult | null;
  buildStatus: "success" | "error" | "not_run";
  buildErrors: unknown[] | null;
  hasBuildArtifact: boolean;
  fixedIssues: Array<{ issueId: string; description: string }>;
}

// ---------------------------------------------------------------------------
// Steps / task
// ---------------------------------------------------------------------------

const QA_STEPS: AgentStep[] = [
  { id: "audit-workspace", label: "Audit workspace" },
  { id: "apply-fixes", label: "Apply deterministic fixes" },
  { id: "rebuild", label: "Rebuild and re-validate" },
  { id: "final-validation", label: "Final validation" },
  { id: "finish", label: "QA complete" },
];

function makeTask(): AgentTask {
  return {
    objective:
      "Audit a generated website workspace, apply safe deterministic fixes, rebuild, and verify again.",
    constraints: [
      "Treat verifiedFacts and research unknowns as hard constraints.",
      "Never invent business facts, contact information, testimonials, pricing, services, or reviews.",
      "Only apply deterministic, safe, reproducible fixes.",
      "Unknowns must never be turned into facts.",
      "Never browse the web or execute shell commands.",
    ],
    acceptanceCriteria: [
      "QA status is PASS with no medium-or-higher issues remaining.",
      "Final deterministic build validation succeeds.",
      "No unsafe executable or protocol-relative links remain.",
      "All workspace files remain inside the isolated project directory.",
      "The final artifact is readable and structurally valid.",
    ],
    steps: QA_STEPS,
    allowedActions: [
      "website.qa",
      "qa.fix",
      "website.build",
      "website.validate",
      "workspace.list",
      "workspace.read",
    ],
    verificationRequirements: [
      "QA status PASS (no medium or higher issues remain).",
      "No critical contact or business-safety issues remain.",
      "Final build validation succeeds.",
      "Workspace isolation intact.",
    ],
    maxIterations: DEFAULT_MAX_ITERATIONS,
  };
}

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

export interface QaAgentDeps {
  /** Override the build tool (for deterministic failure tests). */
  build?: (
    projectId: string,
    requiredFiles?: string[],
  ) => Promise<BuildResult> | BuildResult;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebsiteQaAgent(deps: QaAgentDeps = {}): Agent {
  const buildFn = deps.build ?? buildWorkspace;

  const resolver = (context: AgentContext): QaReferences & { projectId: string } => {
    const refs = (context.references ?? {}) as QaReferences;
    const projectId = resolveProjectId(refs);
    return { ...refs, projectId };
  };

  // ---- planner ------------------------------------------------------------

  const planner: TaskPlanner = {
    plan(input) {
      const refs = (input.context ?? {}) as QaReferences;
      if (!referencesAreValid(refs) && !refs.projectId) {
        throw new Error(
          "references.lead, references.research, or references.verifiedFacts is required.",
        );
      }
      return makeTask();
    },
  };

  // ---- inspect ------------------------------------------------------------

  async function inspectImpl(
    context: AgentContext,
    state: AgentLoopState,
  ): Promise<AgentObservation> {
    const refs = resolver(context);
    let workspaceExists = false;
    let files: string[] = [];
    let qa: QaResult | null = null;
    let buildStatus: InspectionData["buildStatus"] = "not_run";
    let buildErrors: unknown[] | null = null;
    let hasBuildArtifact = false;

    try {
      const entries = await listWorkspaceFiles(refs.projectId);
      workspaceExists = true;
      files = entries.map((e) => e.path);
    } catch {
      workspaceExists = false;
    }

    if (workspaceExists && files.length > 0) {
      try {
        const manifest = await readBuildManifest(refs.projectId);
        hasBuildArtifact = manifest !== null;
        const snapshot = await readQaWorkspace(
          refs.projectId,
          refs.requiredFiles ?? BASE_REQUIRED_FILES,
        );
        qa = auditWorkspace(snapshot, refs);
        buildStatus = snapshot.build.status;
        buildErrors =
          snapshot.build.status === "error" ? snapshot.build.findings : null;
      } catch {
        qa = null;
      }
    }

    const lastWithFixed = [...state.observations]
      .reverse()
      .find((o) => Array.isArray(o.state?.fixedIssues));
    const fixedIssues = (lastWithFixed?.state?.fixedIssues ??
      []) as InspectionData["fixedIssues"];

    return {
      id: randomUUID(),
      iteration: state.actions.length,
      description: qa
        ? `QA audit: status=${qa.status}, score=${qa.score}, issues=${qa.issues.length}`
        : workspaceExists
          ? "Workspace present but audit could not be computed."
          : "Workspace does not exist yet.",
      state: {
        projectId: refs.projectId,
        workspaceExists,
        files,
        qa,
        buildStatus,
        buildErrors,
        hasBuildArtifact,
        fixedIssues,
      } satisfies InspectionData,
      at: new Date().toISOString(),
    };
  }

  // ---- decide -------------------------------------------------------------

  function decideImpl(
    _context: AgentContext,
    state: AgentLoopState,
    observation: AgentObservation,
  ): AgentAction {
    const ins = observation.state as unknown as InspectionData | undefined;
    const lastActionName = state.actions.at(-1)?.name ?? null;

    if (!ins || !ins.workspaceExists) {
      // Nothing to audit — keep probing until max iterations.
      return {
        name: "website.qa",
        permission: "read",
        description: "Audit missing workspace",
        completesStep: false,
      };
    }

    if (lastActionName === null) {
      return {
        name: "website.qa",
        permission: "read",
        description: "Run the full deterministic QA audit",
        completesStep: true,
        nextStepId:
          ins.qa?.status === "PASS" ? "final-validation" : "apply-fixes",
      };
    }

    if (lastActionName === "website.qa") {
      if (!ins.qa) {
        return {
          name: "website.qa",
          permission: "read",
          description: "Re-run QA audit",
          completesStep: false,
        };
      }
      if (ins.qa.status === "PASS") {
        if (!ins.hasBuildArtifact) {
          // A PASS is only meaningful after a durable build validation
          // exists; never trust a fresh in-memory read-only check.
          return {
            name: "website.build",
            permission: "execute",
            description: "Persist the durable build validation result",
            completesStep: true,
            nextStepId: "final-validation",
          };
        }
        return {
          name: "website.validate",
          permission: "read",
          description: "Final validation of the built site",
          completesStep: true,
          nextStepId: "finish",
        };
      }
      const fixable = ins.qa.issues.filter((i) => i.fixable);
      if (fixable.length > 0) {
        return {
          name: "qa.fix",
          permission: "write",
          description: `Apply ${fixable.length} deterministic fix(es)`,
          completesStep: true,
          nextStepId: "rebuild",
        };
      }
      // Dead-end: only non-fixable issues remain. Re-audit until max
      // iterations so the run fails safely with the issues visible.
      return {
        name: "website.qa",
        permission: "read",
        description: "Re-audit (only non-fixable issues remain)",
        completesStep: false,
      };
    }

    if (lastActionName === "qa.fix") {
      return {
        name: "website.build",
        permission: "execute",
        description: "Rebuild after applying fixes",
        completesStep: true,
        nextStepId: "final-validation",
      };
    }

    if (lastActionName === "website.build") {
      return {
        name: "website.qa",
        permission: "read",
        description: "Re-audit after rebuild",
        completesStep: false,
      };
    }

    if (lastActionName === "website.validate") {
      // Final validation ran; if verify() still fails, re-audit.
      return {
        name: "website.qa",
        permission: "read",
        description: "Re-audit after final validation",
        completesStep: false,
      };
    }

    return {
      name: "website.qa",
      permission: "read",
      description: "Re-audit workspace",
      completesStep: false,
    };
  }

  // ---- verify -------------------------------------------------------------

  async function verifyImpl(
    context: AgentContext,
    state: AgentLoopState,
  ): Promise<AgentVerification> {
    const refs = resolver(context);
    const checks: AgentVerificationCheck[] = [];
    const lastAction = state.actions.at(-1);

    checks.push({
      requirement: "Final website.validate action succeeded",
      passed: Boolean(
        lastAction &&
          lastAction.name === "website.validate" &&
          lastAction.status === "succeeded",
      ),
      detail:
        lastAction && lastAction.name !== "website.validate"
          ? `last action was "${lastAction.name}"`
          : lastAction && lastAction.status !== "succeeded"
            ? `last action "${lastAction.name}" did not succeed`
            : "no final validation action recorded",
    });

    let qa: QaResult | null = null;
    let buildOk = false;

    try {
      const manifest = (await readBuildManifest(refs.projectId)) as
        | { status?: string }
        | null;
      buildOk = manifest?.status === "success";

      const snapshot = await readQaWorkspace(
        refs.projectId,
        refs.requiredFiles ?? BASE_REQUIRED_FILES,
      );
      qa = auditWorkspace(snapshot, refs);
    } catch {
      qa = null;
      buildOk = false;
    }

    checks.push({
      requirement: "QA status is PASS (no medium or higher issues)",
      passed: Boolean(qa && qa.status === "PASS"),
      detail: qa
        ? `${qa.issues.length} issue(s); status ${qa.status}`
        : "no QA result computed",
    });

    const critical = qa
      ? qa.issues.filter(
          (i) =>
            i.severity === "critical" ||
            (i.severity === "high" &&
              (i.category === "business-safety" ||
                i.category === "contact" ||
                i.category === "link")),
        )
      : [];
    checks.push({
      requirement: "No critical contact / business-safety / link issues",
      passed: critical.length === 0,
      detail:
        critical.length > 0
          ? `${critical.length} critical/safety issue(s) remain`
          : undefined,
    });

    checks.push({
      requirement: "Deterministic build validation succeeds",
      passed: buildOk,
      detail: buildOk ? undefined : "build validation failed or was not run",
    });

    try {
      const entries = await listWorkspaceFiles(refs.projectId);
      const names = new Set(entries.map((e) => e.path));
      const required = refs.requiredFiles ?? BASE_REQUIRED_FILES;
      const missing = required.filter((r) => !names.has(r));
      checks.push({
        requirement: "All required workspace files present",
        passed: missing.length === 0,
        detail: missing.length > 0 ? `missing: ${missing.join(", ")}` : undefined,
      });

      const escaped = entries.some(
        (e) => e.path.startsWith("..") || e.path.startsWith("/"),
      );
      checks.push({
        requirement: "Workspace isolation intact",
        passed: !escaped,
        detail: escaped ? "a workspace path escapes the project root" : undefined,
      });
    } catch {
      checks.push({
        requirement: "Workspace readable",
        passed: false,
        detail: "workspace could not be listed",
      });
    }

    const passed = checks.every((c) => c.passed);
    return {
      id: randomUUID(),
      iteration: state.actions.length,
      passed,
      checks,
      at: new Date().toISOString(),
    };
  }

  // ---- tools --------------------------------------------------------------

  const tools: Agent["tools"] = [
    {
      name: "website.qa",
      description:
        "Run the deterministic QA audit over the workspace and return the full QaResult.",
      permission: "read",
      async execute(input: { projectId?: string } = {}, context: AgentContext) {
        const refs = resolver(context);
        const projectId = input.projectId ?? refs.projectId;
        const snapshot = await readQaWorkspace(
          projectId,
          refs.requiredFiles ?? BASE_REQUIRED_FILES,
        );
        return auditWorkspace(snapshot, refs);
      },
    },
    {
      name: "qa.fix",
      description:
        "Plan and apply deterministic, safe fixes for every fixable QA issue, writing only changed files.",
      permission: "write",
      async execute(input: { projectId?: string } = {}, context: AgentContext) {
        const refs = resolver(context);
        const projectId = input.projectId ?? refs.projectId;
        const snapshot = await readQaWorkspace(
          projectId,
          refs.requiredFiles ?? BASE_REQUIRED_FILES,
        );
        const qa = auditWorkspace(snapshot, refs);
        const fixes = planFixes(qa, snapshot.files);
        if (fixes.length === 0) {
          return { applied: [], failed: [], changedFiles: [], fixedIssues: [] };
        }
        const report: QaFixReport = applyFixes(snapshot.files, fixes);
        if (report.changedFiles.length > 0) {
          await writeWorkspaceFiles(projectId, report.changedFiles);
        }
        const fixedIssueIds = new Set(report.applied.map((a) => a.issueId));
        const fixedIssues = fixes
          .map((fx) => qa.issues.find((i) => i.id === fx.issueId))
          .filter(
            (i): i is QaIssue =>
              i !== undefined && fixedIssueIds.has(i.id),
          );
        return {
          applied: report.applied.map((a) => a.issueId),
          failed: report.failed.map((f) => f.issueId),
          changedFiles: report.changedFiles.map((c) => c.path),
          fixedIssues: fixedIssues.map((i) => ({
            issueId: i.id,
            description: i.description,
          })),
        };
      },
    },
    {
      name: "website.build",
      description:
        "Run the deterministic build validator and persist the build manifest.",
      permission: "execute",
      async execute(input: { projectId?: string } = {}, context: AgentContext) {
        const refs = resolver(context);
        const projectId = input.projectId ?? refs.projectId;
        return buildFn(projectId, refs.requiredFiles ?? BASE_REQUIRED_FILES);
      },
    },
    {
      name: "website.validate",
      description:
        "Run the deterministic build validation in read-only mode and attach the current QA result.",
      permission: "read",
      async execute(input: { projectId?: string } = {}, context: AgentContext) {
        const refs = resolver(context);
        const projectId = input.projectId ?? refs.projectId;
        const buildResult = await validateWorkspaceReadOnly(
          projectId,
          refs.requiredFiles ?? BASE_REQUIRED_FILES,
        );
        const snapshot = await readQaWorkspace(
          projectId,
          refs.requiredFiles ?? BASE_REQUIRED_FILES,
        );
        return { build: buildResult, qa: auditWorkspace(snapshot, refs) };
      },
    },
    {
      name: "workspace.list",
      description: "List all files in the project workspace.",
      permission: "read",
      execute(input: { projectId?: string } = {}) {
        return listWorkspaceFiles(String(input.projectId ?? ""));
      },
    },
    {
      name: "workspace.read",
      description: "Read a single file from the workspace.",
      permission: "read",
      execute(input: { projectId?: string; path?: string } = {}) {
        return readWorkspaceFile(String(input.projectId ?? ""), String(input.path ?? ""));
      },
    },
    {
      name: "workspace.delete",
      description: "Delete the entire project workspace.",
      permission: "write",
      execute(input: { projectId?: string } = {}) {
        return deleteWorkspace(String(input.projectId ?? ""));
      },
    },
  ];

  return {
    id: "website-qa",
    name: "Website QA Agent",
    description:
      "Audits a generated website workspace, identifies issues deterministically, applies safe fixes, rebuilds, and verifies again without inventing facts.",
    jobType: "website_qa",
    permissions: ["read", "write", "execute"],
    tools,
    planner,
    plan(context: AgentContext) {
      const refs = (context.references ?? {}) as QaReferences;
      if (!referencesAreValid(refs)) {
        throw new Error(
          "references.lead, references.research, or references.verifiedFacts is required.",
        );
      }
      return makeTask();
    },
    inspect: inspectImpl,
    decide: decideImpl,
    verify: verifyImpl,
  };
}