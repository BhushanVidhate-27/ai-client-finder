import { NextResponse } from "next/server";
import { revokeOutreachApproval } from "@/lib/data/outreach";
import { logActivity } from "@/lib/data/activity";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export const dynamic = "force-dynamic";

interface RevokeBody {
  draftId?: unknown;
}

/**
 * POST /api/admin/outreach/safety/revoke
 *
 * Revokes the active valid approval for a draft. The safety evaluation will
 * then return WAIT_FOR_APPROVAL instead of SEND until a fresh approval is
 * issued. Never sends anything.
 */
export async function POST(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  let body: RevokeBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const draftId = typeof body.draftId === "string" ? body.draftId : "";
  if (!draftId) {
    return NextResponse.json(
      { error: "draftId is required." },
      { status: 400 },
    );
  }

  const revoked = revokeOutreachApproval(draftId);
  if (!revoked) {
    return NextResponse.json(
      { error: "No valid approval found for this draft." },
      { status: 404 },
    );
  }

  logActivity({
    action: "outreach.approval_revoked",
    metadata: { draftId },
  });

  return NextResponse.json({ ok: true });
}