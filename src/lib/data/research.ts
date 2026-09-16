import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/data/db";
import type { WebsiteResearch } from "@/lib/lead-research";

export interface ResearchRow {
  id: string;
  leadId: string;
  websiteResearch: WebsiteResearch;
  status: "complete";
  createdAt: string;
  updatedAt: string;
}

type StoredRow = Record<string, unknown>;

function parseStored(row: StoredRow): ResearchRow {
  return {
    id: String(row.id),
    leadId: String(row.lead_id),
    websiteResearch: JSON.parse(String(row.website_research_json)) as WebsiteResearch,
    status: "complete",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function upsertResearch(
  leadId: string,
  websiteResearch: WebsiteResearch,
): ResearchRow {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id FROM research WHERE lead_id = ?")
    .get(leadId) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE research SET website_research_json = ?, status = ?, updated_at = ? WHERE lead_id = ?",
    ).run(JSON.stringify(websiteResearch), "complete", now, leadId);
    const row = db
      .prepare("SELECT * FROM research WHERE lead_id = ?")
      .get(leadId)!;
    return parseStored(row);
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO research (id, lead_id, website_research_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, leadId, JSON.stringify(websiteResearch), "complete", now, now);
  return { id, leadId, websiteResearch, status: "complete", createdAt: now, updatedAt: now };
}

export function getResearchByLeadId(leadId: string): ResearchRow | null {
  const row = getDb().prepare("SELECT * FROM research WHERE lead_id = ?").get(leadId);
  return row ? parseStored(row) : null;
}