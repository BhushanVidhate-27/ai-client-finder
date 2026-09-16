import { PermissionError } from "./permissions";
import type { AgentPermission } from "./permissions";
import type { AgentAction, AgentContext, AgentTool } from "./types";

export class ToolNotFoundError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Tool "${toolName}" is not available to this agent.`);
    this.name = "ToolNotFoundError";
    this.toolName = toolName;
  }
}

export class ToolNotImplementedError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(
      `Tool "${toolName}" is declared but has no executor yet. Step 9 defines interfaces only.`,
    );
    this.name = "ToolNotImplementedError";
    this.toolName = toolName;
  }
}

/**
 * Permission-gated registry of the tools an agent may invoke during one loop.
 * Every run goes through this class so that sensitive categories (write,
 * execute, deploy, external) are only reachable when explicitly granted.
 */
export class AgentToolbox {
  private readonly tools: Map<string, AgentTool>;
  private readonly granted: Set<AgentPermission>;

  constructor(tools: AgentTool[], granted: AgentPermission[]) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.granted = new Set(granted);
  }

  hasPermission(permission: AgentPermission): boolean {
    return this.granted.has(permission);
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  grantedPermissions(): AgentPermission[] {
    return [...this.granted];
  }

  /**
   * Runs one action. Throws PermissionError when the action's permission
   * category is not granted, ToolNotFoundError when it is unknown, and
   * ToolNotImplementedError when the tool has no executor yet.
   */
  async run(action: AgentAction, context: AgentContext): Promise<unknown> {
    if (!this.granted.has(action.permission)) {
      throw new PermissionError(action.name, action.permission);
    }
    const tool = this.tools.get(action.name);
    if (!tool) throw new ToolNotFoundError(action.name);
    if (!tool.execute) throw new ToolNotImplementedError(action.name);
    return tool.execute(action.input, context);
  }
}