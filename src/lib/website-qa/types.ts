import type { QualifiedLead } from "@/lib/lead-qualification";
import type { WebsiteResearch } from "@/lib/lead-research";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import type { WebsiteBlueprint, WebsiteProject } from "@/lib/website-project";
import type { WorkspaceFileWithContent } from "@/lib/website-coding/workspace";
import type { BuildFinding } from "@/lib/website-coding/build";

/**
 * Categories of issues the Website QA agent inspects for.
 */
export type QaCategory =
  | "structural"
  | "content"
  | "contact"
  | "link"
  | "responsive"
  | "accessibility"
  | "business-safety";

export type QaSeverity = "critical" | "high" | "medium" | "low";

/**
 * Kinds of deterministic, safe fixes the QA agent may apply. Every fix must be
 * reproducible from the issue evidence alone; nothing invents new facts.
 */
export type QaFixKind =
  | "remove-element"
  | "remove-sentence"
  | "remove-contact-item"
  | "remove-service-card"
  | "remove-testimonial"
  | "fix-internal-link"
  | "add-alt"
  | "add-viewport";

export interface QaIssue {
  id: string;
  category: QaCategory;
  severity: QaSeverity;
  description: string;
  file: string | null;
  /** The exact source-of-truth snippet that triggered the issue. */
  evidence: string;
  fixable: boolean;
  fixKind?: QaFixKind;
}

export interface QaCheck {
  id: string;
  name: string;
  category: QaCategory;
  passed: boolean;
  detail?: string;
}

export interface QaAudit {
  passed: boolean;
  checks: QaCheck[];
  issues: QaIssue[];
}

export type QaStatus = "PASS" | "FAIL";

/**
 * Structured result produced by every QA run. `fixedIssues` lists issues that
 * were fixed by the agent in a previous iteration; `remainingIssues` lists
 * problems still present at this exact point in time.
 */
export interface QaResult {
  status: QaStatus;
  score: number;
  issues: QaIssue[];
  fixedIssues: QaIssue[];
  remainingIssues: QaIssue[];
  checks: QaCheck[];
  contentAudit: QaAudit;
  safetyAudit: QaAudit;
  accessibilityAudit: QaAudit;
  recommendations: string[];
}

/**
 * The evidence the QA agent is allowed to treat as fact. `targetNiche` is a
 * *suspicion hint* — it is never evidence, so a site claiming the target
 * niche without verified support is rejected (CASE A).
 */
export interface QaReferences {
  projectId?: string;
  lead?: QualifiedLead | null;
  research?: WebsiteResearch | null;
  contact?: ContactDiscovery | null;
  blueprint?: WebsiteProject | WebsiteBlueprint | null;
  verifiedFacts?: string[];
  unknowns?: string[];
  requiredFiles?: string[];
  targetNiche?: string | null;
}

/**
 * Pure input to the QA engine. `build` findings (from the deterministic build
 * validator) may be supplied to enrich the structural audit; when absent the
 * engine still checks everything it can from content alone.
 */
export interface QaAuditInput {
  files: WorkspaceFileWithContent[];
  refs: QaReferences;
  build?: {
    findings: BuildFinding[];
    status: "success" | "error" | "not_run";
  } | null;
}

/**
 * A single deterministic fix. `target` is the exact substring in the file to
 * operate on; `replacement` is used by insert/rewrite fixes.
 */
export interface QaFix {
  issueId: string;
  kind: QaFixKind;
  file: string;
  target: string;
  replacement?: string;
}

/**
 * Result of applying a batch of fixes to the workspace files.
 */
export interface QaFixReport {
  applied: QaFix[];
  failed: QaFix[];
  changedFiles: Array<{ path: string; content: string }>;
}