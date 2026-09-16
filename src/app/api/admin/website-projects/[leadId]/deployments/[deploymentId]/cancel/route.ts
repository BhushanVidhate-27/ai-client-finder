import { NextResponse } from "next/server";
import {
  getDeploymentRecord,
  isActiveDeploymentStatus,
  markDeploymentCancelled,
} from "@/lib/data/deployments";
import { getJobController } from "@/lib/jobs/registry";
import { getDefaultDeploymentRegistry } from "@/lib/deployment/registry";
import { logActivity } from "@/lib/data/activity";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ leadId: string; deploymentId: string }> },
) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const { leadId, deploymentId } = await params;
  const record = getDeploymentRecord(deploymentId);
  if (!record) {
    return NextResponse.json({ error: "Deployment not found." }, { status: 404 });
  }

  if (!isActiveDeploymentStatus(record.status)) {
    return NextResponse.json(
      { error: `Deployment is already ${record.status}.` },
      { status: 409 },
    );
  }

  const registry = getDefaultDeploymentRegistry();
  const adapter = registry.getAdapter(record.provider);

  if (record.jobId) {
    const controller = getJobController(record.jobId);
    if (controller) {
      // In-flight loop: request a cooperative stop. The flow is responsible
      // for marking the record cancelled and calling the provider's cancel.
      controller.requestStop();
      logActivity({
        action: "deployment.cancel_requested",
        leadId,
        metadata: { deploymentId },
      });
      return NextResponse.json({ ok: true, status: "stopping" });
    }
  }

  // No in-process job (queued/stale): cancel the record directly and request a
  // provider-level cancel when the provider supports it.
  if (adapter && record.providerDeploymentId && adapter.supportsCancel) {
    await adapter
      .cancelDeployment({
        providerDeploymentId: record.providerDeploymentId,
        status: record.status,
        url: record.deploymentUrl,
      })
      .catch(() => {});
  }

  markDeploymentCancelled(deploymentId, { reason: "cancelled_by_user" });

  logActivity({
    action: "deployment.cancelled",
    leadId,
    metadata: { deploymentId },
  });

  return NextResponse.json({ ok: true, status: "cancelled" });
}