import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/data/db";
import type { LeadQualification, QualifiedLead } from "@/lib/lead-qualification";
import type { ContactDiscovery } from "@/lib/contact-discovery";
import { countWebsiteVersions, getLatestWebsiteVersion } from "@/lib/data/websites";
import { getResearchByLeadId } from "@/lib/data/research";

export interface StoredLead {
  id: string;
  placeId: string;
  campaignId: string | null;
  businessName: string;
  address: string;
  website: string | null;
  mapsUrl: string;
  phone: string | null;
  rating: number | null;
  reviewCount: number | null;
  businessStatus: string | null;
  primaryType: string | null;
  types: string[];
  qualification: LeadQualification | null;
  contactDiscovery: ContactDiscovery | null;
  createdAt: string;
  updatedAt: string;
}

export interface DuplicateInfo {
  firstSeenCampaignId: string | null;
  firstSeenAt: string;
  websiteVersions: number;
  latestWebsiteVersion: number | null;
  lastGeneratedAt: string | null;
  lastResearchedAt: string | null;
}

export interface LeadView extends Omit<QualifiedLead, "qualification"> {
  leadId: string;
  qualification: LeadQualification;
  contactDiscovery: ContactDiscovery | null;
  existing: boolean;
  duplicateInfo: DuplicateInfo | null;
}

type StoredRow = Record<string, unknown>;

function unavailableQualification(reason: string): LeadQualification {
  return {
    opportunityScore: 0,
    qualified: false,
    reason,
    websiteAssessment: "Not assessed",
    qualificationStatus: "unavailable",
  };
}

function parseStoredLead(row: StoredRow): StoredLead {
  let types: string[] = [];
  try {
    const parsed = JSON.parse(String(row.types_json ?? "[]"));
    if (Array.isArray(parsed)) {
      types = parsed.filter((t): t is string => typeof t === "string");
    }
  } catch {
    types = [];
  }

  let qualification: LeadQualification | null = null;
  if (typeof row.qualification_json === "string" && row.qualification_json) {
    try {
      qualification = JSON.parse(row.qualification_json) as LeadQualification;
    } catch {
      qualification = null;
    }
  }

  let contactDiscovery: ContactDiscovery | null = null;
  if (
    typeof row.contact_discovery_json === "string" &&
    row.contact_discovery_json
  ) {
    try {
      contactDiscovery = JSON.parse(
        row.contact_discovery_json,
      ) as ContactDiscovery;
    } catch {
      contactDiscovery = null;
    }
  }

  return {
    id: String(row.id),
    placeId: String(row.place_id),
    campaignId: row.campaign_id ? String(row.campaign_id) : null,
    businessName: String(row.business_name),
    address: String(row.address),
    website: row.website ? String(row.website) : null,
    mapsUrl: String(row.maps_url),
    phone: row.phone ? String(row.phone) : null,
    rating: row.rating !== null && row.rating !== undefined ? Number(row.rating) : null,
    reviewCount:
      row.review_count !== null && row.review_count !== undefined
        ? Number(row.review_count)
        : null,
    businessStatus: row.business_status ? String(row.business_status) : null,
    primaryType: row.primary_type ? String(row.primary_type) : null,
    types,
    qualification,
    contactDiscovery,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getLeadById(id: string): StoredLead | null {
  const row = getDb().prepare("SELECT * FROM leads WHERE id = ?").get(id);
  return row ? parseStoredLead(row) : null;
}

export function getLeadByPlaceId(placeId: string): StoredLead | null {
  const row = getDb().prepare("SELECT * FROM leads WHERE place_id = ?").get(placeId);
  return row ? parseStoredLead(row) : null;
}

export interface UpsertResult {
  lead: StoredLead;
  created: boolean;
}

export function upsertLeadFromDiscovery(
  lead: QualifiedLead,
  options?: { updateExisting?: boolean },
): UpsertResult {
  const db = getDb();
  const updateExisting = options?.updateExisting ?? true;
  const now = new Date().toISOString();
  const existing = getLeadByPlaceId(lead.placeId);

  if (existing) {
    if (updateExisting) {
      db.prepare(
        `UPDATE leads SET
           business_name = ?, address = ?, website = ?, maps_url = ?,
           phone = ?, rating = ?, review_count = ?, business_status = ?,
           primary_type = ?, types_json = ?, qualification_json = ?,
           updated_at = ?
         WHERE id = ?`,
      ).run(
        lead.businessName,
        lead.address,
        lead.websiteUrl ?? null,
        lead.googleMapsUrl,
        lead.internationalPhoneNumber ?? lead.nationalPhoneNumber ?? null,
        lead.rating ?? null,
        lead.reviewCount ?? null,
        lead.businessStatus ?? null,
        lead.primaryType ?? null,
        JSON.stringify(lead.types ?? []),
        JSON.stringify(lead.qualification),
        now,
        existing.id,
      );
    } else {
      const qualification =
        existing.qualification ?? lead.qualification;
      if (!existing.qualification) {
        db.prepare(
          "UPDATE leads SET qualification_json = ?, updated_at = ? WHERE id = ?",
        ).run(JSON.stringify(qualification), now, existing.id);
      }
    }
    return { lead: getLeadById(existing.id)!, created: false };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO leads (
       id, place_id, campaign_id, business_name, address, website, maps_url,
       phone, rating, review_count, business_status, primary_type, types_json,
       qualification_json, created_at, updated_at
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    lead.placeId,
    lead.businessName,
    lead.address,
    lead.websiteUrl ?? null,
    lead.googleMapsUrl,
    lead.internationalPhoneNumber ?? lead.nationalPhoneNumber ?? null,
    lead.rating ?? null,
    lead.reviewCount ?? null,
    lead.businessStatus ?? null,
    lead.primaryType ?? null,
    JSON.stringify(lead.types ?? []),
    JSON.stringify(lead.qualification),
    now,
    now,
  );
  return { lead: getLeadById(id)!, created: true };
}

export function updateLeadContactDiscovery(
  leadId: string,
  discovery: ContactDiscovery,
): void {
  getDb()
    .prepare(
      "UPDATE leads SET contact_discovery_json = ?, updated_at = ? WHERE id = ?",
    )
    .run(JSON.stringify(discovery), new Date().toISOString(), leadId);
}

export function setLeadPrimaryCampaign(
  leadId: string,
  campaignId: string,
): void {
  getDb()
    .prepare("UPDATE leads SET campaign_id = ? WHERE id = ?")
    .run(campaignId, leadId);
}

export function updateLeadQualificationData(
  leadId: string,
  qualification: LeadQualification,
): void {
  getDb()
    .prepare(
      "UPDATE leads SET qualification_json = ?, updated_at = ? WHERE id = ?",
    )
    .run(JSON.stringify(qualification), new Date().toISOString(), leadId);
}

export function toLeadView(lead: StoredLead): LeadView {
  const qualification =
    lead.qualification ?? unavailableQualification("Qualification is not available.");

  return {
    leadId: lead.id,
    placeId: lead.placeId,
    businessName: lead.businessName,
    address: lead.address,
    googleMapsUrl: lead.mapsUrl,
    websiteUrl: lead.website ?? undefined,
    internationalPhoneNumber: lead.phone ?? undefined,
    nationalPhoneNumber: undefined,
    rating: lead.rating ?? undefined,
    reviewCount: lead.reviewCount ?? undefined,
    businessStatus: lead.businessStatus ?? undefined,
    primaryType: lead.primaryType ?? undefined,
    types: lead.types,
    qualification,
    contactDiscovery: lead.contactDiscovery,
    existing: false,
    duplicateInfo: null,
  };
}

export function enrichDuplicateInfo(
  view: LeadView,
  lead: StoredLead,
  duplicateInfo: DuplicateInfo,
): LeadView {
  return { ...view, existing: true, duplicateInfo };
}

export function buildDuplicateInfo(lead: StoredLead): DuplicateInfo {
  const latestVersion = getLatestWebsiteVersion(lead.id);
  const research = getResearchByLeadId(lead.id);
  return {
    firstSeenCampaignId: lead.campaignId,
    firstSeenAt: lead.createdAt,
    websiteVersions: countWebsiteVersions(lead.id),
    latestWebsiteVersion: latestVersion ? latestVersion.version : null,
    lastGeneratedAt: latestVersion ? latestVersion.createdAt : null,
    lastResearchedAt: research?.updatedAt ?? null,
  };
}

export function toQualifiedLead(stored: StoredLead): QualifiedLead {
  return {
    placeId: stored.placeId,
    businessName: stored.businessName,
    address: stored.address,
    googleMapsUrl: stored.mapsUrl,
    websiteUrl: stored.website ?? undefined,
    internationalPhoneNumber: stored.phone ?? undefined,
    nationalPhoneNumber: undefined,
    rating: stored.rating ?? undefined,
    reviewCount: stored.reviewCount ?? undefined,
    businessStatus: stored.businessStatus ?? undefined,
    primaryType: stored.primaryType ?? undefined,
    types: stored.types,
    qualification:
      stored.qualification ??
      unavailableQualification("Qualification is not available."),
  };
}