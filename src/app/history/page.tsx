import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/context";
import HistoryClient from "../history-client";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/history");
  return <HistoryClient />;
}