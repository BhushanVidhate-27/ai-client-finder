import { NextResponse } from "next/server";
import {
  getWebsiteProjectRecordByLeadId,
  listWebsiteProjectVersions,
} from "@/lib/data/websites";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leadId: string }> },
) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const { leadId } = await params;
  const project = getWebsiteProjectRecordByLeadId(leadId);
  if (!project) {
    return NextResponse.json(
      { error: "Website project not found." },
      { status: 404 },
    );
  }

  return NextResponse.json({
    versions: listWebsiteProjectVersions(project.projectId),
  });
}