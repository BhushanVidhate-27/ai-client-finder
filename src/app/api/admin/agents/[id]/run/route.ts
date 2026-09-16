import { NextResponse } from "next/server";
import { ensureJobStateFresh } from "@/lib/data/jobs";
import { seedDefaultAgents, getAgent, isAgentRunnable } from "@/lib/agents/registry";
import { runAgentWorkflow, AgentExecutionError } from "@/lib/agents/run-agent-workflow";
import { JobStopped } from "@/lib/jobs/run-job";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

seedDefaultAgents();

interface RunBody {
  goal?: unknown;
  constraints?: unknown;
  references?: unknown;
  maxIterations?: unknown;
  timeoutMs?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const { id } = await params;
  ensureJobStateFresh();

  const def = getAgent(id);
  if (!def) {
    return NextResponse.json(
      { error: "Agent not found." },
      { status: 404 },
    );
  }

  if (!isAgentRunnable(id)) {
    return NextResponse.json(
      {
        error:
          `Agent "${def.name}" is not runnable in Step 9. Only the Loop Sanity Agent is available.`,
      },
      { status: 400 },
    );
  }

  let body: RunBody;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const goal =
    typeof body.goal === "string" && body.goal.trim()
      ? body.goal.trim()
      : def.description;

  let result: Awaited<ReturnType<typeof runAgentWorkflow>>;

  try {
    result = await runAgentWorkflow({
      agentId: id,
      goal,
      constraints: Array.isArray(body.constraints)
        ? (body.constraints.filter((c): c is string => typeof c === "string"))
        : undefined,
      references:
        typeof body.references === "object" && body.references !== null
          ? (body.references as Record<string, unknown>)
          : undefined,
      options: {
        maxIterations:
          typeof body.maxIterations === "number" && body.maxIterations > 0
            ? body.maxIterations
            : undefined,
        timeoutMs:
          typeof body.timeoutMs === "number" && body.timeoutMs > 0
            ? body.timeoutMs
            : undefined,
      },
    });
  } catch (error) {
    if (error instanceof AgentExecutionError) {
      return NextResponse.json(
        { error: error.message, status: "failed" },
        { status: 200 },
      );
    }
    if (error instanceof JobStopped) {
      return NextResponse.json(
        { error: "Agent run was stopped.", status: "stopped" },
        { status: 200 },
      );
    }
    return NextResponse.json(
      { error: "Agent run failed.", status: "failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    jobId: result.jobId,
    status: result.result.status,
    iteration: result.result.iteration,
    maxIterations: result.result.maxIterations,
    progress: result.result.progress,
    currentStep: result.result.currentStepLabel,
    error: result.result.error,
  });
}