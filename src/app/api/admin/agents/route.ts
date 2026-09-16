import { NextResponse } from "next/server";
import { ensureJobStateFresh } from "@/lib/data/jobs";
import { seedDefaultAgents, listAgents } from "@/lib/agents/registry";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

seedDefaultAgents();

export async function GET(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  ensureJobStateFresh();
  const defs = listAgents();
  return NextResponse.json({ agents: defs });
}