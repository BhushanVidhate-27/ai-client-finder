import { NextResponse } from "next/server";
import { getDefaultDeploymentRegistry } from "@/lib/deployment/registry";
import { requireAuth, unauthorizedResponse } from "@/lib/auth/http";

export async function GET(request: Request) {
  const sessionUser = await requireAuth(request);
  if (!sessionUser) return unauthorizedResponse();

  const registry = getDefaultDeploymentRegistry();
  const providers = registry.listProviders();

  const states = await Promise.all(
    providers.map(async (p) => {
      const connection = await registry.getProviderConnectionState(p.id);
      return { ...p, state: connection.state, message: connection.message };
    }),
  );

  return NextResponse.json({ providers: states });
}