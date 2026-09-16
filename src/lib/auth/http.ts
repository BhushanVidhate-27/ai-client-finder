import { NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";

export async function readSessionFromRequest(
  request: Request,
): Promise<string | null> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`).exec(
    cookieHeader,
  );
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  if (!token) return null;
  return verifySessionToken(token);
}

export async function requireAuth(
  request: Request,
): Promise<string | null> {
  return readSessionFromRequest(request);
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}