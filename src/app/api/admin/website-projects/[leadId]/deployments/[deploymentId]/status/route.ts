import { NextResponse } from "next/server";
import { getDeploymentRecord } from "@/lib/data/deployments";
import { getDefaultDeploymentRegistry } from "@/lib/deployment/registry";
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

  const registry = getDefaultDeploymentRegistry();
  const adapter = registry.getAdapter(record.provider);
  if (!adapter || !record.providerDeploymentId) {
    return NextResponse.json({
      deploymentId: record.id,
      status: record.status,
      url: record.deploymentUrl,
      providerStatus: null,
      providerMessage: null,
    });
  }

  try {
    const snapshot = await adapter.getDeploymentStatus({
      providerDeploymentId: record.providerDeploymentId,
      status: record.status,
      url: record.deploymentUrl,
    });
    return NextResponse.json({
      deploymentId: record.id,
      status: record.status,
      url: record.deploymentUrl,
      providerStatus: snapshot.status,
      providerMessage: snapshot.message,
    });
  } catch {
    return NextResponse.json({
      deploymentId: record.id,
      status: record.status,
      url: record.deploymentUrl,
      providerStatus: null,
      providerMessage: "Could not reach provider.",
    });
  }
}
