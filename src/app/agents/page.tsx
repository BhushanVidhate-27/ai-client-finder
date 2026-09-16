import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/context";
import AgentsClient from "../agents-client";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/agents");
  return <AgentsClient />;
}