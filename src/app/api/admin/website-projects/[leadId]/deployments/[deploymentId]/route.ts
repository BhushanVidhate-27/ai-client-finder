import { NextResponse } from "next/server";
import { getDeploymentRecord } from "@/lib/data/deployments";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leadId: string; deploymentId: string }> },
) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const { deploymentId } = await params;
  const record = getDeploymentRecord(deploymentId);
  if (!record) {
    return NextResponse.json({ error: "Deployment not found." }, { status: 404 });
  }

  return NextResponse.json({ deployment: record });
}
