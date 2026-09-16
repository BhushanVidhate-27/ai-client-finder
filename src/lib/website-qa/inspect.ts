import type { QaAuditInput, QaReferences, QaResult } from "./types";
import type { BuildFinding, BuildResult } from "@/lib/website-coding/build";
import {
  listWorkspaceFiles,
  getWorkspaceFilesWithContent,
  readBuildManifest,
} from "@/lib/website-coding/workspace";
import { validateWorkspaceReadOnly } from "@/lib/website-coding/build";
import { runQaAudit } from "./rules";

export interface QaWorkspaceSnapshot {
  projectId: string;
  workspaceExists: boolean;
  files: Awaited<ReturnType<typeof getWorkspaceFilesWithContent>>;
  build: {
    findings: BuildFinding[];
    status: "success" | "error" | "not_run";
  };
}

/**
 * Read the entire workspace + build manifest into a portable snapshot that can
 * be passed to `runQaAudit` (pure) or stored in the observation state. Throws
 * when the workspace does not yet exist; callers should catch ENOENT.
 */
export async function readQaWorkspace(
  projectId: string,
  requiredFiles?: string[],
): Promise<QaWorkspaceSnapshot> {
  // Throws ENOENT when workspace dir does not exist yet.
  const entries = await listWorkspaceFiles(projectId);
  const files = entries.length > 0
    ? await getWorkspaceFilesWithContent(projectId)
    : [];

  const buildResult = (await readBuildManifest(projectId)) as BuildResult | null;
  const buildFindings: BuildFinding[] =
    buildResult && "errors" in buildResult ? [...buildResult.errors] : [];

  let buildStatus: QaWorkspaceSnapshot["build"]["status"] = "not_run";
  if (buildResult) {
    buildStatus = buildResult.status === "success" ? "success" : "error";
  } else if (files.length > 0) {
    const validation = await validateWorkspaceReadOnly(projectId, requiredFiles);
    buildStatus = validation.status === "success" ? "success" : "error";
    if (validation.status === "error") {
      buildFindings.push(...validation.errors);
    }
  }

  return {
    projectId,
    workspaceExists: files.length > 0,
    files,
    build: { findings: buildFindings, status: buildStatus },
  };
}

/**
 * Build the full QA audit from a workspace snapshot and supplied references.
 * This is the primary entry point the agent tool calls each iteration.
 */
export function auditWorkspace(
  snapshot: QaWorkspaceSnapshot,
  refs: QaReferences,
): QaResult {
  const input: QaAuditInput = {
    files: snapshot.files,
    refs,
    build: snapshot.build,
  };
  return runQaAudit(input);
}