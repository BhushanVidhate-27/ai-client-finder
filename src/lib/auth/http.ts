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

/**
 * Same-origin (CSRF) check for mutating requests. Mirrors the proxy's
 * enforcement so high-stakes routes stay protected even when invoked directly
 * (e.g. tests, or if proxy config changes). A request without a matching
 * Origin header is rejected.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}