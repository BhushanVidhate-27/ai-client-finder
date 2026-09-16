import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/data/db";
import { resetDatabase } from "@/lib/data/schema";
import { createCampaign, linkCampaignLead, listCampaignIdsByLeadId, listLeadsByCampaign } from "@/lib/data/campaigns";
import { upsertLeadFromDiscovery, setLeadPrimaryCampaign, toLeadView } from "@/lib/data/leads";
import { makeLead } from "./helpers";

beforeEach(() => {
  resetDatabase(getDb());
});

describe("duplicate campaign linking", () => {
  it("links an existing lead into a new campaign without creating a second lead row", () => {
    const campaignA = createCampaign({ niche: "Plumbing", location: "Nowhere", requestedLeadCount: 5, status: "ok" });
    const campaignB = createCampaign({ niche: "Emergency plumbing", location: "Nowhere", requestedLeadCount: 5, status: "ok" });

    const first = upsertLeadFromDiscovery(makeLead("place-1"), { updateExisting: false });
    expect(first.created).toBe(true);
    setLeadPrimaryCampaign(first.lead.id, campaignA.id);
    linkCampaignLead(campaignA.id, first.lead.id);

    const second = upsertLeadFromDiscovery(makeLead("place-1"), { updateExisting: false });
    expect(second.created).toBe(false);
    expect(second.lead.id).toBe(first.lead.id);
    // Duplicate: link into the new campaign too (idempotent INSERT OR IGNORE).
    linkCampaignLead(campaignB.id, second.lead.id);
    linkCampaignLead(campaignB.id, second.lead.id);

    const count = getDb().prepare("SELECT COUNT(*) AS c FROM leads").get() as { c: number };
    expect(Number(count.c)).toBe(1);

    expect(listLeadsByCampaign(campaignA.id).map((r) => String(r.id))).toContain(first.lead.id);
    expect(listLeadsByCampaign(campaignB.id).map((r) => String(r.id))).toContain(first.lead.id);

    const campaignIds = listCampaignIdsByLeadId(first.lead.id);
    expect(campaignIds.sort()).toEqual([campaignA.id, campaignB.id].sort());

    // The campaign detail view marks a pre-existing lead as existing.
    const stored = upsertLeadFromDiscovery(makeLead("place-1")).lead;
    const view = toLeadView(stored);
    view.existing = stored.campaignId !== null && stored.campaignId !== campaignB.id;
    expect(view.existing).toBe(true);
  });

  it("upserting the same placeId twice never duplicates the lead row", () => {
    const first = upsertLeadFromDiscovery(makeLead("place-dup"), { updateExisting: false });
    const second = upsertLeadFromDiscovery(makeLead("place-dup"), { updateExisting: false });
    const third = upsertLeadFromDiscovery(makeLead("place-dup"), { updateExisting: true });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(first.lead.id).toBe(second.lead.id);
    expect(first.lead.id).toBe(third.lead.id);

    const rows = getDb().prepare("SELECT * FROM leads WHERE place_id = ?").all("place-dup");
    expect(rows).toHaveLength(1);
  });
});