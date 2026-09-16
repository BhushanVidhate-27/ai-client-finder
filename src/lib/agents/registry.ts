import type { Agent } from "./types";
import type { AgentPermission } from "./permissions";
import { sanityAgent } from "./sanity-agent";
import { createWebsiteCodingAgent } from "@/lib/website-coding/agent";
import { createWebsiteQaAgent } from "@/lib/website-qa/agent";
import { createOutreachSafetyAgent } from "@/lib/outreach-safety/agent";
import { createCampaignOrchestratorAgent } from "@/lib/campaign-orchestrator/agent";

export type AgentDefinitionStatus = "available" | "planned";

/**
 * A lightweight record that lets the UI/history system identify which agent
 * ran, which job it belongs to, what iteration it reached, and what result it
 * produced. The optional `runner` is the runtime implementation only when the
 * agent is wired up and runnable.
 */
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  jobType: string;
  permissions: AgentPermission[];
  status: AgentDefinitionStatus;
  runner?: Agent;
}

const agents = new Map<string, AgentDefinition>();

export function registerAgent(def: AgentDefinition): void {
  agents.set(def.id, { ...def });
}

export function getAgent(id: string): AgentDefinition | undefined {
  const def = agents.get(id);
  return def ? { ...def } : undefined;
}

export function listAgents(): AgentDefinition[] {
  return [...agents.values()].map((a) => ({ ...a }));
}

export function isAgentRunnable(id: string): boolean {
  const def = agents.get(id);
  return Boolean(def && def.status === "available" && def.runner);
}

let defaultsSeeded = false;

/**
 * Registers the built-in set of agents. Called once at startup; idempotent.
 */
export function seedDefaultAgents(): void {
  if (defaultsSeeded) return;
  defaultsSeeded = true;

  // ---- future agents (status: "planned") ----

  registerAgent({
    id: "qualification",
    name: "Qualification Agent",
    description: "Evaluates whether a lead is worth pursuing. Wired in Steps 1–8 but not yet an agent loop.",
    jobType: "lead_update",
    permissions: ["read"],
    status: "planned",
  });

  registerAgent({
    id: "research",
    name: "Research Agent",
    description: "Generates website research for a qualified lead. Currently runs as a one-shot workflow.",
    jobType: "research",
    permissions: ["read", "external"],
    status: "planned",
  });

  registerAgent({
    id: "website-builder",
    name: "Website Builder Agent",
    description: "Generates a multi-page website from research output. Planned for Step 10.",
    jobType: "website_generation",
    permissions: ["read", "write"],
    status: "planned",
  });

  registerAgent({
    id: "qa",
    name: "QA Agent",
    description: "Inspects builds and verifies accessibility, performance and correctness. Not yet implemented.",
    jobType: "agent_loop_sanity",
    permissions: ["read"],
    status: "planned",
  });

  registerAgent({
    id: "deployment",
    name: "Deployment Agent",
    description: "Deploys the verified website artifact to the configured hosting provider.",
    jobType: "deployment",
    permissions: ["read", "execute", "deploy"],
    status: "planned",
  });

  registerAgent({
    id: "outreach",
    name: "Outreach Agent",
    description: "Discovers contacts and sends personalised outreach. Not yet implemented.",
    jobType: "agent_loop_sanity",
    permissions: ["read", "external"],
    status: "planned",
  });

  // ---- runnable outreach send-safety agent (Agent 8 / Step 14) ----

  const outreachSafetyAgent = createOutreachSafetyAgent();
  registerAgent({
    id: outreachSafetyAgent.id,
    name: outreachSafetyAgent.name,
    description: outreachSafetyAgent.description,
    jobType: outreachSafetyAgent.jobType,
    permissions: outreachSafetyAgent.permissions,
    status: "available",
    runner: outreachSafetyAgent,
  });

  // ---- runnable campaign orchestrator agent (Agent 9 / Step 15) ----

  const campaignOrchestratorAgent = createCampaignOrchestratorAgent();
  registerAgent({
    id: campaignOrchestratorAgent.id,
    name: campaignOrchestratorAgent.name,
    description: campaignOrchestratorAgent.description,
    jobType: campaignOrchestratorAgent.jobType,
    permissions: campaignOrchestratorAgent.permissions,
    status: "available",
    runner: campaignOrchestratorAgent,
  });

  // ---- runnable website coding agent ----

  const websiteCodingAgent = createWebsiteCodingAgent();
  registerAgent({
    id: websiteCodingAgent.id,
    name: websiteCodingAgent.name,
    description: websiteCodingAgent.description,
    jobType: websiteCodingAgent.jobType,
    permissions: websiteCodingAgent.permissions,
    status: "available",
    runner: websiteCodingAgent,
  });

  // ---- runnable website QA agent ----

  const websiteQaAgent = createWebsiteQaAgent();
  registerAgent({
    id: websiteQaAgent.id,
    name: websiteQaAgent.name,
    description: websiteQaAgent.description,
    jobType: websiteQaAgent.jobType,
    permissions: websiteQaAgent.permissions,
    status: "available",
    runner: websiteQaAgent,
  });

  // ---- runnable demo agent ----

  registerAgent({
    id: sanityAgent.id,
    name: sanityAgent.name,
    description: sanityAgent.description,
    jobType: sanityAgent.jobType,
    permissions: sanityAgent.permissions,
    status: "available",
    runner: sanityAgent,
  });
}