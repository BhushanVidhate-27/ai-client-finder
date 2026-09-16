/**
 * Outreach send-safety persistence (Agent 8 / Step 14).
 *
 * Drafts, approvals, opt-outs and send authorizations are separate persisted
 * concepts. The safety evaluator is the ONLY writer of send-authorization rows
 * (on a successful deterministic SEND evaluation), so future email transport
 * can rely on the DB as the source of truth for "already handled".
 *
 * Approvals are bound to the exact draft identity: prospect + draft + the
 * normalized recipient email + the server-computed draft hash. Nothing here
 * ever transfers an approval between prospects, drafts, recipients or website
 * versions.
 */

import { randomUUID, createHash } from "node:crypto";
import { getDb, withTransaction } from "@/lib/data/db";

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export type OutreachDraftStatus = "pending_review" | "eligible" | "blocked";

export interface OutreachDraftRow {
  id: string;
  leadId: string;
  subject: string | null;
  body: string;
  contentHash: string;
  status: OutreachDraftStatus;
  websiteVersionId: string | null;
  websiteUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OutreachDraftCreateInput {
  leadId: string;
  subject?: string | null;
  body: string;
  status?: OutreachDraftStatus;
  websiteVersionId?: string | null;
  websiteUrl?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Deterministic SHA-256 over the draft's subject + body. This is the identity
 * used by approvals, idempotency and duplicate protection. It is always
 * computed server-side; client-supplied hashes are never trusted.
 */
export function hashOutreachDraft(subject: string | null, body: string): string {
  const h = createHash("sha256");
  h.update(subject ?? "");
  h.update("\0");
  h.update(body);
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type StoredRow = Record<string, unknown>;

function parseMetadata(json: unknown): Record<string, unknown> {
  if (typeof json !== "string" || !json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseDraftRow(row: StoredRow): OutreachDraftRow {
  return {
    id: String(row.id),
    leadId: String(row.lead_id),
    subject: row.subject ? String(row.subject) : null,
    body: String(row.body),
    contentHash: String(row.content_hash),
    status: String(row.status) as OutreachDraftStatus,
    websiteVersionId: row.website_version_id
      ? String(row.website_version_id)
      : null,
    websiteUrl: row.website_url ? String(row.website_url) : null,
    metadata: parseMetadata(row.metadata_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseApprovalRow(row: StoredRow): OutreachApprovalRow {
  return {
    id: String(row.id),
    leadId: String(row.lead_id),
    draftId: String(row.draft_id),
    recipientEmail: String(row.recipient_email),
    draftHash: String(row.draft_hash),
    status: String(row.status) as OutreachApprovalStatus,
    createdBy: row.created_by ? String(row.created_by) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseOptOutRow(row: StoredRow): OutreachOptOutRow {
  return {
    leadId: String(row.lead_id),
    signal: String(row.signal),
    source: String(row.source),
    createdAt: String(row.created_at),
  };
}

function parseSendRow(row: StoredRow): OutreachSendRow {
  return {
    id: String(row.id),
    leadId: String(row.lead_id),
    draftId: String(row.draft_id),
    recipientEmail: String(row.recipient_email),
    draftHash: String(row.draft_hash),
    idempotencyKey: String(row.idempotency_key),
    decision: String(row.decision),
    status: String(row.status) as OutreachSendStatus,
    websiteVersionId: row.website_version_id
      ? String(row.website_version_id)
      : null,
    deploymentUrl: row.deployment_url ? String(row.deployment_url) : null,
    failureReason: row.failure_reason ? String(row.failure_reason) : null,
    provider: row.provider ? String(row.provider) : null,
    messageId: row.message_id ? String(row.message_id) : null,
    metadata: parseMetadata(row.metadata_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export function createOutreachDraft(
  input: OutreachDraftCreateInput,
): OutreachDraftRow {
  const now = new Date().toISOString();
  const id = randomUUID();
  const contentHash = hashOutreachDraft(input.subject ?? null, input.body);
  getDb()
    .prepare(
      `INSERT INTO outreach_drafts (
         id, lead_id, subject, body, content_hash, status, website_version_id,
         website_url, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.leadId,
      input.subject ?? null,
      input.body,
      contentHash,
      input.status ?? "pending_review",
      input.websiteVersionId ?? null,
      input.websiteUrl ?? null,
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
    );
  return getOutreachDraft(id)!;
}

export function getOutreachDraft(id: string): OutreachDraftRow | null {
  const row = getDb()
    .prepare("SELECT * FROM outreach_drafts WHERE id = ?")
    .get(id);
  return row ? parseDraftRow(row) : null;
}

export function listOutreachDraftsByLead(leadId: string): OutreachDraftRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM outreach_drafts WHERE lead_id = ? ORDER BY created_at DESC",
    )
    .all(leadId) as StoredRow[];
  return rows.map(parseDraftRow);
}

export function updateOutreachDraftStatus(
  id: string,
  status: OutreachDraftStatus,
): OutreachDraftRow | null {
  getDb()
    .prepare(
      "UPDATE outreach_drafts SET status = ?, updated_at = ? WHERE id = ?",
    )
    .run(status, new Date().toISOString(), id);
  return getOutreachDraft(id);
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export type OutreachApprovalStatus = "valid" | "revoked";

export interface OutreachApprovalRow {
  id: string;
  leadId: string;
  draftId: string;
  recipientEmail: string;
  draftHash: string;
  status: OutreachApprovalStatus;
  createdBy: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutreachApprovalCreateInput {
  leadId: string;
  draftId: string;
  recipientEmail: string;
  draftHash: string;
  createdBy: string | null;
  expiresAt?: string | null;
}

/**
 * Creates a human approval bound to the exact draft identity and revokes any
 * previously-valid approval for the same draft (at most one valid approval per
 * draft is enforced by a partial unique index). Approval never carries over to
 * a changed hash/recipient — the caller re-approves the exact content.
 */
export function createOutreachApproval(
  input: OutreachApprovalCreateInput,
): OutreachApprovalRow {
  return withTransaction(() => {
    const db = getDb();
    const now = new Date().toISOString();

    const existing = db
      .prepare(
        "SELECT id FROM outreach_approvals WHERE draft_id = ? AND status = 'valid'",
      )
      .get(input.draftId) as { id: string } | undefined;
    if (existing) {
      db.prepare(
        "UPDATE outreach_approvals SET status = 'revoked', updated_at = ? WHERE id = ?",
      ).run(now, existing.id);
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO outreach_approvals (
         id, lead_id, draft_id, recipient_email, draft_hash, status,
         created_by, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'valid', ?, ?, ?, ?)`,
    ).run(
      id,
      input.leadId,
      input.draftId,
      input.recipientEmail,
      input.draftHash,
      input.createdBy ?? null,
      input.expiresAt ?? null,
      now,
      now,
    );
    return parseApprovalRow(
      db.prepare("SELECT * FROM outreach_approvals WHERE id = ?").get(id)!,
    );
  });
}

export function getValidOutreachApproval(
  draftId: string,
): OutreachApprovalRow | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM outreach_approvals WHERE draft_id = ? AND status = 'valid' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(draftId);
  return row ? parseApprovalRow(row) : null;
}

/**
 * Latest approval ever recorded for an exact draft, regardless of status.
 * Approvals are bound to the draft identity (prospect + draft + recipient +
 * hash); this is used by the transport gate so a cross-prospect approval is
 * detected as a binding violation instead of being silently treated as absent.
 */
export function getOutreachApprovalByDraft(
  draftId: string,
): OutreachApprovalRow | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM outreach_approvals WHERE draft_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(draftId);
  return row ? parseApprovalRow(row) : null;
}

export function listOutreachApprovalsByLead(
  leadId: string,
): OutreachApprovalRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM outreach_approvals WHERE lead_id = ? ORDER BY created_at DESC",
    )
    .all(leadId) as StoredRow[];
  return rows.map(parseApprovalRow);
}

export function revokeOutreachApproval(draftId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE outreach_approvals SET status = 'revoked', updated_at = ?
       WHERE draft_id = ? AND status = 'valid'`,
    )
    .run(new Date().toISOString(), draftId);
  return Number(result.changes) > 0;
}

// ---------------------------------------------------------------------------
// Opt-outs
// ---------------------------------------------------------------------------

export interface OutreachOptOutRow {
  leadId: string;
  signal: string;
  source: string;
  createdAt: string;
}

export function recordOutreachOptOut(
  leadId: string,
  signal: string,
  source: string,
): OutreachOptOutRow {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO outreach_opt_outs (lead_id, signal, source, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(leadId, signal, source, now);
  return getOutreachOptOut(leadId)!;
}

export function getOutreachOptOut(leadId: string): OutreachOptOutRow | null {
  const row = getDb()
    .prepare("SELECT * FROM outreach_opt_outs WHERE lead_id = ?")
    .get(leadId);
  return row ? parseOptOutRow(row) : null;
}

export function removeOutreachOptOut(leadId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM outreach_opt_outs WHERE lead_id = ?")
    .run(leadId);
  return Number(result.changes) > 0;
}

// ---------------------------------------------------------------------------
// Send authorization / idempotency
// ---------------------------------------------------------------------------

export type OutreachSendStatus =
  | "authorized"
  | "sending"
  | "sent"
  | "blocked"
  | "failed";

export interface OutreachSendRow {
  id: string;
  leadId: string;
  draftId: string;
  recipientEmail: string;
  draftHash: string;
  idempotencyKey: string;
  decision: string;
  status: OutreachSendStatus;
  websiteVersionId: string | null;
  deploymentUrl: string | null;
  failureReason: string | null;
  provider: string | null;
  messageId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OutreachSendCreateInput {
  leadId: string;
  draftId: string;
  recipientEmail: string;
  draftHash: string;
  idempotencyKey: string;
  decision: string;
  status?: OutreachSendStatus;
  websiteVersionId?: string | null;
  deploymentUrl?: string | null;
}

/**
 * Deterministic idempotency key for one exact send operation. The same lead +
 * draft + recipient + draft hash always yields the same key, so a repeated
 * evaluation can never create a second authorization.
 */
export function buildIdempotencyKey(input: {
  leadId: string;
  draftId: string;
  recipientEmail: string;
  draftHash: string;
}): string {
  const h = createHash("sha256");
  h.update(input.leadId);
  h.update("\0");
  h.update(input.draftId);
  h.update("\0");
  h.update(input.recipientEmail);
  h.update("\0");
  h.update(input.draftHash);
  return h.digest("hex");
}

export function getOutreachSendByKey(key: string): OutreachSendRow | null {
  const row = getDb()
    .prepare("SELECT * FROM outreach_sends WHERE idempotency_key = ?")
    .get(key);
  return row ? parseSendRow(row) : null;
}

export function getOutreachSendByBinding(input: {
  leadId: string;
  draftId: string;
  recipientEmail: string;
  draftHash: string;
}): OutreachSendRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM outreach_sends
       WHERE lead_id = ? AND draft_id = ? AND recipient_email = ? AND draft_hash = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.leadId, input.draftId, input.recipientEmail, input.draftHash);
  return row ? parseSendRow(row) : null;
}

export function hasPriorSend(input: {
  leadId: string;
  draftId: string;
  recipientEmail: string;
  draftHash: string;
}): boolean {
  return getOutreachSendByBinding(input) !== null;
}

/**
 * Persists a send authorization for an exact send operation. Enforced by two
 * DB constraints (unique idempotency key + unique prospect/draft/recipient/
 * hash binding): a second authorization for the same operation can never be
 * written, so attaching the token to a different key is also impossible.
 */
export function recordSendAuthorization(
  input: OutreachSendCreateInput,
): OutreachSendRow {
  const now = new Date().toISOString();
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO outreach_sends (
         id, lead_id, draft_id, recipient_email, draft_hash, idempotency_key,
         decision, status, website_version_id, deployment_url, failure_reason,
         metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', ?, ?)`,
    )
    .run(
      id,
      input.leadId,
      input.draftId,
      input.recipientEmail,
      input.draftHash,
      input.idempotencyKey,
      input.decision,
      input.status ?? "authorized",
      input.websiteVersionId ?? null,
      input.deploymentUrl ?? null,
      now,
      now,
    );
  return getOutreachSendByKey(input.idempotencyKey)!;
}

export interface OutreachSendUpdateInput {
  status?: OutreachSendStatus;
  failureReason?: string | null;
  metadata?: Record<string, unknown>;
  messageId?: string | null;
  provider?: string | null;
}

/**
 * Updates a send record in place. Used by the email transport service to
 * transition an `authorized` row to `sent` (or `failed`) after a provider
 * run, and to record the provider metadata for auditability. Legal state
 * transitions are enforced by the caller (transport service), not here: this
 * is a low-level persistence helper.
 */
export function updateOutreachSend(
  id: string,
  input: OutreachSendUpdateInput,
): OutreachSendRow | null {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM outreach_sends WHERE id = ?")
    .get(id) as StoredRow | undefined;
  if (!existing) return null;

  const now = new Date().toISOString();
  const currentMetadata =
    existing.metadata_json && typeof existing.metadata_json === "string"
      ? (() => {
          try {
            return JSON.parse(existing.metadata_json) as Record<string, unknown>;
          } catch {
            return {};
          }
        })()
      : {};

  const status = input.status ?? String(existing.status);
  const provider =
    input.provider !== undefined
      ? input.provider
      : existing.provider
        ? String(existing.provider)
        : null;
  const messageId =
    input.messageId !== undefined
      ? input.messageId
      : existing.message_id
        ? String(existing.message_id)
        : null;
  const failureReason =
    input.failureReason !== undefined
      ? input.failureReason
      : existing.failure_reason
        ? String(existing.failure_reason)
        : null;
  const metadata = {
    ...currentMetadata,
    ...input.metadata,
  };

  db.prepare(
    `UPDATE outreach_sends
       SET status = ?, provider = ?, message_id = ?, failure_reason = ?,
           metadata_json = ?, updated_at = ?
       WHERE id = ?`,
  ).run(
    status,
    provider,
    messageId,
    failureReason,
    JSON.stringify(metadata),
    now,
    id,
  );
  return getOutreachSendByKey(String(existing.idempotency_key));
}

/**
 * Atomically claims a send record for transport by transitioning it from a
 * non-in-flight status to "sending". Returns the claimed row on success, or
 * null when another concurrent caller has already claimed it.
 *
 * Legal transitions:
 *   authorized → sending (fresh claim)
 *   failed     → sending (explicit retry)
 */
export function claimOutreachSendForTransport(
  id: string,
): OutreachSendRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE outreach_sends
         SET status = 'sending', updated_at = ?
       WHERE id = ? AND status IN ('authorized', 'failed')`,
    )
    .run(now, id);
  if (Number(result.changes) === 0) return null;
  return getOutreachSendByKey(
    (
      db
        .prepare("SELECT idempotency_key FROM outreach_sends WHERE id = ?")
        .get(id) as { idempotency_key: string }
    )?.idempotency_key,
  );
}

export function listOutreachSendsByLead(
  leadId: string,
): OutreachSendRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM outreach_sends WHERE lead_id = ? ORDER BY created_at DESC",
    )
    .all(leadId) as StoredRow[];
  return rows.map(parseSendRow);
}

/** Re-exports used by tests to assert the idempotency backstop is not bypassable. */
export function isUniqueViolationError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  return /UNIQUE|SQLITE_CONSTRAINT/i.test(code);
}