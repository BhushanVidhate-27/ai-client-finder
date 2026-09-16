import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/context";
import AppHome from "./home-client";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/");
  return <AppHome />;
}