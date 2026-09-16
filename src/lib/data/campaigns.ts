import { randomUUID } from "node:crypto";
import { getDb, withTransaction } from "@/lib/data/db";

export interface CampaignRow {
  id: string;
  niche: string;
  location: string;
  requestedLeadCount: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

type StoredRow = Record<string, unknown>;

function toCampaign(row: StoredRow): CampaignRow {
  return {
    id: String(row.id),
    niche: String(row.niche),
    location: String(row.location),
    requestedLeadCount: Number(row.requested_lead_count),
    status: String(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createCampaign(input: {
  niche: string;
  location: string;
  requestedLeadCount: number;
  status: string;
}): CampaignRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO campaigns (id, niche, location, requested_lead_count, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.niche,
    input.location,
    input.requestedLeadCount,
    input.status,
    now,
    now,
  );
  return getCampaign(id)!;
}

export function getCampaign(id: string): CampaignRow | null {
  const row = getDb().prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
  return row ? toCampaign(row) : null;
}

export function listCampaigns(limit = 100): CampaignRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT ?")
    .all(limit) as StoredRow[];
  return rows.map(toCampaign);
}

export function updateCampaignStatus(id: string, status: string): CampaignRow | null {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, now, id);
  return getCampaign(id);
}

export function linkCampaignLead(campaignId: string, leadId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id, created_at) VALUES (?, ?, ?)`,
    )
    .run(campaignId, leadId, new Date().toISOString());
}

export function listCampaignIdsByLeadId(leadId: string): string[] {
  const rows = getDb()
    .prepare(
      "SELECT campaign_id FROM campaign_leads WHERE lead_id = ? ORDER BY created_at",
    )
    .all(leadId) as Array<{ campaign_id: string }>;
  return rows.map((row) => row.campaign_id);
}

export function listLeadsByCampaign(campaignId: string): StoredRow[] {
  return getDb()
    .prepare(
      `SELECT l.* FROM leads l
       JOIN campaign_leads cl ON cl.lead_id = l.id
       WHERE cl.campaign_id = ?
       ORDER BY cl.created_at`,
    )
    .all(campaignId) as StoredRow[];
}

export function countCampaignLeads(campaignId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM campaign_leads WHERE campaign_id = ?")
    .get(campaignId) as { count: number };
  return Number(row.count);
}

export function campaignLeadCounts(campaignIds: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (campaignIds.length === 0) return result;
  const db = getDb();
  const stmt = db.prepare(
    "SELECT COUNT(*) AS count FROM campaign_leads WHERE campaign_id = ?",
  );
  for (const campaignId of campaignIds) {
    const row = stmt.get(campaignId) as { count: number };
    result.set(campaignId, Number(row.count));
  }
  return result;
}

export function withTransactionDo<T>(fn: () => T): T {
  return withTransaction(fn);
}