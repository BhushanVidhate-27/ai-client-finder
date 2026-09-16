/**
 * Basic permission model for agent actions.
 *
 * Every action an agent takes must map to one of these categories. A loop run
 * is granted a set of categories up front; taking an action whose category is
 * not granted raises PermissionError so the framework can never execute
 * unapproved work (e.g. arbitrary file writes, shell execution or deploys).
 */

export const AGENT_PERMISSION_CATEGORIES = [
  "read",
  "write",
  "execute",
  "deploy",
  "external",
] as const;

export type AgentPermission = (typeof AGENT_PERMISSION_CATEGORIES)[number];

export const AGENT_PERMISSION_LABELS: Record<AgentPermission, string> = {
  read: "read",
  write: "write",
  execute: "execute",
  deploy: "deploy",
  external: "external",
};

export function isAgentPermission(value: unknown): value is AgentPermission {
  return (
    typeof value === "string" &&
    (AGENT_PERMISSION_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * An explicit grant of a permission category for one loop execution. Future
 * tool implementations should require that their category appears here before
 * doing anything sensitive.
 */
export interface PermissionGrant {
  category: AgentPermission;
  notes?: string;
}

export class PermissionError extends Error {
  readonly action: string;
  readonly permission: AgentPermission;

  constructor(action: string, permission: AgentPermission) {
    super(
      `Action "${action}" requires ${permission} permission, which is not granted to this agent run.`,
    );
    this.name = "PermissionError";
    this.action = action;
    this.permission = permission;
  }
}