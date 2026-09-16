import { NextResponse } from "next/server";
import { ensureJobStateFresh, listJobs } from "@/lib/data/jobs";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export async function GET(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  ensureJobStateFresh();
  return NextResponse.json({ jobs: listJobs(50) });
}