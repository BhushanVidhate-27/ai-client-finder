import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE campaigns (
        id TEXT PRIMARY KEY,
        niche TEXT NOT NULL,
        location TEXT NOT NULL,
        requested_lead_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE leads (
        id TEXT PRIMARY KEY,
        place_id TEXT NOT NULL UNIQUE,
        campaign_id TEXT,
        business_name TEXT NOT NULL,
        address TEXT NOT NULL,
        website TEXT,
        maps_url TEXT NOT NULL,
        phone TEXT,
        rating REAL,
        review_count INTEGER,
        business_status TEXT,
        primary_type TEXT,
        types_json TEXT NOT NULL DEFAULT '[]',
        qualification_json TEXT,
        contact_discovery_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE campaign_leads (
        campaign_id TEXT NOT NULL,
        lead_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (campaign_id, lead_id)
      );

      CREATE TABLE research (
        id TEXT PRIMARY KEY,
        lead_id TEXT UNIQUE NOT NULL,
        website_research_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE website_versions (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        website_project_json TEXT NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agent_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        campaign_id TEXT,
        lead_id TEXT,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        current_step TEXT,
        started_at TEXT,
        completed_at TEXT,
        stopped_at TEXT,
        error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE activity_log (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        campaign_id TEXT,
        lead_id TEXT,
        job_id TEXT,
        website_version_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_leads_place_id ON leads(place_id);
      CREATE INDEX idx_leads_campaign ON leads(campaign_id);
      CREATE INDEX idx_campaign_leads_lead ON campaign_leads(lead_id);
      CREATE INDEX idx_campaign_leads_campaign ON campaign_leads(campaign_id);
      CREATE INDEX idx_research_lead ON research(lead_id);
      CREATE INDEX idx_website_versions_lead ON website_versions(lead_id);
      CREATE INDEX idx_jobs_created ON agent_jobs(created_at);
      CREATE INDEX idx_jobs_lead ON agent_jobs(lead_id);
      CREATE INDEX idx_activity_lead ON activity_log(lead_id);
      CREATE INDEX idx_activity_campaign ON activity_log(campaign_id);
      CREATE INDEX idx_activity_job ON activity_log(job_id);
    `,
  },
  {
    version: 2,
    sql: `
      -- Website version integrity: at most one version number per lead and at
      -- most one current version per lead. Enforced in the database so
      -- concurrent generation/retry cannot create conflicting versions.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_website_versions_lead_version
        ON website_versions(lead_id, version);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_website_versions_one_current
        ON website_versions(lead_id) WHERE is_current = 1;
    `,
  },
  {
    version: 3,
    sql: `
      -- Website project persistence (Step 12).
      --
      -- website_projects is the durable, lead-scoped project record (exactly
      -- one project per canonical lead identity). website_versions extends the
      -- existing version table with a project binding plus build/QA/hash/
      -- workspace metadata. Version numbers are unique per project and at most
      -- one version may be current per project; both invariants are enforced
      -- by partial unique indexes so concurrent generation cannot corrupt them.
      CREATE TABLE website_projects (
        id TEXT PRIMARY KEY,
        lead_id TEXT UNIQUE NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      ALTER TABLE website_versions ADD COLUMN project_id TEXT;
      ALTER TABLE website_versions ADD COLUMN build_status TEXT;
      ALTER TABLE website_versions ADD COLUMN qa_status TEXT;
      ALTER TABLE website_versions ADD COLUMN workspace_id TEXT;
      ALTER TABLE website_versions ADD COLUMN artifact_hash TEXT;
      ALTER TABLE website_versions ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

      CREATE INDEX IF NOT EXISTS idx_website_projects_lead ON website_projects(lead_id);
      CREATE INDEX IF NOT EXISTS idx_website_versions_project ON website_versions(project_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_website_versions_project_version
        ON website_versions(project_id, version) WHERE project_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_website_versions_one_current_project
        ON website_versions(project_id) WHERE is_current = 1 AND project_id IS NOT NULL;

      -- Backfill: one project per lead that already has stored website source,
      -- and bind every existing version row to its lead's project so the whole
      -- history remains consistent with the new project-scoped invariants.
      INSERT INTO website_projects (id, lead_id, current_version, status, created_at, updated_at)
      SELECT lead_id, lead_id,
             COALESCE(
               (SELECT MAX(version) FROM website_versions wv
                WHERE wv.lead_id = t.lead_id AND wv.is_current = 1),
               0
             ),
             'active',
             MIN(t.created_at),
             MAX(t.created_at)
      FROM website_versions t
      GROUP BY t.lead_id;

      UPDATE website_versions SET project_id = lead_id WHERE project_id IS NULL;
    `,
  },
  {
    version: 4,
    sql: `
      -- Hosting/deployment persistence (Step 13).
      --
      -- deployments records every deployment attempt for a website project.
      -- A deployment references an immutable website version row (by its
      -- website_versions.id, never by a mutable workspace path) and is only
      -- created after server-side eligibility/hash verification. At most one
      -- deployment may be active per project at a time: the partial unique
      -- index below makes the concurrency policy deterministic even under
      -- racing starts.
      CREATE TABLE deployments (
        id TEXT PRIMARY KEY,
        website_project_id TEXT NOT NULL,
        lead_id TEXT NOT NULL,
        website_version_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_deployment_id TEXT,
        deployment_url TEXT,
        job_id TEXT,
        artifact_hash TEXT,
        failure_reason TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_deployments_lead ON deployments(lead_id);
      CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(website_project_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_one_active_project
        ON deployments(website_project_id)
        WHERE status IN ('pending', 'validating', 'uploading', 'building', 'deploying');
    `,
  },
  {
    version: 5,
    sql: `
      -- Outreach send-safety persistence (Agent 8 / Step 14).
      --
      -- outreach_drafts persists a draft that A6 (or the operator) attaches to
      -- a lead. content_hash is a deterministic SHA-256 over subject+body; a
      -- draft row is only ever re-hashed server-side, never from client input.
      -- status is lifecycle metadata set by the drafting pipeline
      -- (pending_review | eligible | blocked).
      CREATE TABLE outreach_drafts (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        subject TEXT,
        body TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_review',
        website_version_id TEXT,
        website_url TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outreach_drafts_lead ON outreach_drafts(lead_id);
      CREATE INDEX IF NOT EXISTS idx_outreach_drafts_version
        ON outreach_drafts(website_version_id) WHERE website_version_id IS NOT NULL;

      -- outreach_approvals binds a human approval to the exact draft identity:
      -- prospect + draft + normalized recipient email + draft hash. At most one
      -- valid approval per draft (partial unique index; revoking frees the
      -- slot). Approvals never transfer between prospects/drafts/recipients.
      CREATE TABLE outreach_approvals (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        draft_id TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        draft_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'valid',
        created_by TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outreach_approvals_lead ON outreach_approvals(lead_id);
      CREATE INDEX IF NOT EXISTS idx_outreach_approvals_draft ON outreach_approvals(draft_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_approvals_one_valid
        ON outreach_approvals(draft_id) WHERE status = 'valid';

      -- outreach_opt_outs records an explicit no-contact signal per lead.
      -- Opt-out always overrides any existing approval.
      CREATE TABLE outreach_opt_outs (
        lead_id TEXT PRIMARY KEY,
        signal TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- outreach_sends persists the idempotency state that later prevents a
      -- duplicate send. An authorization row is created ONLY by a successful
      -- deterministic SEND evaluation. idempotency_key is UNIQUE and the
      -- (lead, draft, recipient, hash) binding is UNIQUE, so the same exact
      -- outreach can never be authorized twice. status tracks the lifecycle of
      -- the future transport: authorized | sent | blocked | failed.
      CREATE TABLE outreach_sends (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        draft_id TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        draft_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        decision TEXT NOT NULL,
        status TEXT NOT NULL,
        website_version_id TEXT,
        deployment_url TEXT,
        failure_reason TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outreach_sends_lead ON outreach_sends(lead_id);
      CREATE INDEX IF NOT EXISTS idx_outreach_sends_draft ON outreach_sends(draft_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_sends_binding
        ON outreach_sends(lead_id, draft_id, recipient_email, draft_hash);
    `,
  },
  {
    version: 6,
    sql: `
      -- Campaign orchestrator deployment approval (Agent 9 / Step 15).
      --
      -- A human deployment approval is bound to the exact immutable website
      -- version (website_versions.id) and the artifact hash recorded for that
      -- version. At most one valid approval per version is enforced by a
      -- partial unique index (revoking frees the slot). The orchestrator treats
      -- an approval as valid only when it matches the CURRENT verified version
      -- and its exact artifact hash, so a stale or re-targeted approval can
      -- never authorize a different deploy.
      CREATE TABLE deployment_approvals (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        website_version_id TEXT NOT NULL,
        artifact_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'valid',
        created_by TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_deployment_approvals_lead
        ON deployment_approvals(lead_id);
      CREATE INDEX IF NOT EXISTS idx_deployment_approvals_version
        ON deployment_approvals(website_version_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_approvals_one_valid
        ON deployment_approvals(website_version_id) WHERE status = 'valid';
    `,
  },
];

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY
    );
  `);

  const applied = new Set<number>(
    (
      db.prepare("SELECT version FROM migrations").all() as Array<{
        version: number;
      }>
    ).map((row) => Number(row.version)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO migrations (version) VALUES (?)").run(
        migration.version,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function resetDatabase(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE IF EXISTS outreach_sends;
    DROP TABLE IF EXISTS outreach_opt_outs;
    DROP TABLE IF EXISTS outreach_approvals;
    DROP TABLE IF EXISTS outreach_drafts;
    DROP TABLE IF EXISTS deployment_approvals;
    DROP TABLE IF EXISTS deployments;
    DROP TABLE IF EXISTS activity_log;
    DROP TABLE IF EXISTS agent_jobs;
    DROP TABLE IF EXISTS website_projects;
    DROP TABLE IF EXISTS website_versions;
    DROP TABLE IF EXISTS research;
    DROP TABLE IF EXISTS campaign_leads;
    DROP TABLE IF EXISTS leads;
    DROP TABLE IF EXISTS campaigns;
    DROP TABLE IF EXISTS migrations;
  `);
  migrate(db);
}