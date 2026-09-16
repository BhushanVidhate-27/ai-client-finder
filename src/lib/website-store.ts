import { getWebsiteProject as getFromDb } from "@/lib/data/websites";
import type { WebsiteProject } from "@/lib/website-project";

export function getWebsiteProject(projectId: string): WebsiteProject | null {
  return getFromDb(projectId);
}