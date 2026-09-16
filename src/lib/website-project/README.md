# Website Project & Version Persistence (Step 12)

Durable persistence for generated websites: a **website project** is a
lead-scoped record that accumulates **website versions**, and one version is
always the **current** one for that project.

The database is the **source of truth for metadata** (which versions exist,
their status, which one is current, build/QA results, source hash, and the
workspace that holds the artifact). The generated source lives only in the
isolated version workspace under `workspaces/<projectId>-v<N>/`. No generated
source bytes are stored in the database for Step 12 versions.

## Where things live

| Concern | Module |
| --- | --- |
| Project + version rows, transitions, promotion, queries | `src/lib/data/websites.ts` |
| Deterministic source hash (SHA-256) | `src/lib/website-coding/source-hash.ts` |
| Workspace isolation (`workspaces/…`) | `src/lib/website-coding/workspace.ts` |
| Build / build manifest | `src/lib/website-coding/build.ts` |
| Composite generation flow (coding → QA → promote) | `src/lib/jobs/website-project-flow.ts` |
| HTTP entry point for generation | `src/app/api/campaigns/website/route.ts` |
| Read-only project/versions/current APIs | `src/app/api/admin/website-projects/…` |
| Workspace-based preview for versions | `src/lib/website-preview.ts` |
| Schema + migration 3 | `src/lib/data/schema.ts` |

## Data model

### `website_projects`
`id` (primary key), `lead_id` (unique), `current_version`, `status`,
`created_at`, `updated_at`. One project per canonical lead — `lead_id` is
**1:1** and keyed by the stored lead identity, never by business name or any
client-supplied label. `ensureWebsiteProject` creates on demand with
`INSERT OR IGNORE` so concurrent ensures cannot wedge.

### `website_versions` (Step 12 columns added by migration 3)
- `project_id` — binding to the project row (backfilled to `lead_id` for
  pre-existing legacy rows).
- `build_status` — `pending | building | success | failed`.
- `qa_status` — `pending | qa | pass | fail`.
- `workspace_id` — the isolated workspace folder for this version
  (`${projectId}-v${version}`).
- `artifact_hash` — deterministic SHA-256 of the shipped source files.
- `metadata_json` — small key/value metadata (e.g. business name).

Legacy columns (`website_project_json`, `lead_id`, `is_current`, …) are kept
and the legacy functions (`createWebsiteVersion`, `getWebsiteProject`,
`listWebsiteVersions`, `buildDuplicateInfo`, …) behave exactly as before.

### DB-enforced invariants
- `UNIQUE (lead_id, version)` (v2) — legacy per-lead version numbers.
- `UNIQUE (project_id, version) WHERE project_id IS NOT NULL` (v3) — version
  numbers are unique per project.
- Partial unique index `… WHERE is_current = 1 AND project_id IS NOT NULL`
  (v3) — **at most one current version per project**; a hostile direct INSERT
  of a second current row fails at the database layer.
- Migration 3 backfills one `website_projects` row per lead that already had
  stored source and binds every legacy version row to it, so history stays
  project-scoped after upgrade.

## Version lifecycle

Statuses: `draft → building → qa → ready → current`, with `failed` / `stopped`
as terminal dead-ends. Legal transitions are enforced in
`updateWebsiteVersionResult`:

```
draft:    -> building | failed | stopped
building: -> qa | failed | stopped
qa:       -> ready | failed | stopped
ready:    -> current | failed | stopped
current:  -> ready (demotion) | failed | stopped
failed / stopped: (terminal)
```

Build/QA sub-statuses auto-advance the lifecycle only while the version is in
an in-flight state: `buildStatus: "building"` moves a draft to `building`;
`buildStatus: "success"` + `qaStatus: "pass"` move an in-flight version to
`ready`. A `failed` / `stopped` version can never become current.

### Promotion
`promoteWebsiteVersion` is one transaction that:
1. re-reads the target row inside the transaction and refuses anything that is
   not `ready` (or already `current`) with `build_status = 'success'` and
   `qa_status = 'pass'`;
2. demotes the existing current for the same project (`is_current = 0`,
   status `ready`);
3. marks the target `is_current = 1`, status `current`;
4. updates `website_projects.current_version`.

Promotion never happens from `failed`, `stopped`, or an unbound version, and
never creates a partial state (all or nothing).

## Lifecycle in code (`runWebsiteProjectGeneration`)

1. `ensureWebsiteProject(leadId)` — reserve the project (reused across runs).
2. `createWebsiteProjectVersion(leadId)` — insert the next version as a
   `draft` with a unique, deterministic workspace id. Version numbers are
   server-computed `MAX + 1` with a retry-on-unique-violation loop, so a racing
   concurrent run advances to the next number instead of colliding.
3. **Coding agent loop** (status `building`) writes and builds the workspace.
4. **QA agent loop** (status `qa`) audits, applies deterministic fixes, and
   rebuilds.
5. Final verify: build manifest must be `success`, then the deterministic
   source hash is computed and stored.
6. `updateWebsiteVersionResult(… ready / success / pass / hash)`.
7. `promoteWebsiteVersion` — atomically makes the version current.

Both agent loops share the job's `JobController`, so **pause / resume / stop**
gate every agent step: a stop persists the version as `stopped` (the previous
current stays intact), a paused run that is resumed keeps the **same** version
row (created once at the start — no duplicate), and a build/QA failure persists
the version as `failed`. The agents themselves remain independently runnable
via `/api/admin/agents/[id]/run`.

The coding/QA agents use the same `read/write/execute` permissions and the same
workspace safety checks as in Steps 10/11 — nothing new is exposed.

## Workspace mapping & security

- Every version maps to exactly one isolated workspace:
  `workspaces/<projectId>-v<version>/` (folder name stored in `workspace_id`).
- `<projectId>` is the lead id (lowercase UUID), so the constructed workspace
  id is a plain slug accepted by `assertSafeProjectId` and identical to what
  the coding agent slugifies internally.
- Version workspaces are isolated from each other: writing to v2 never touches
  v1, and `deleteWorkspace`/traversal protections apply unchanged.
- The workspace paths are never derived from client input; the server computes
  `projectId`, `version`, `workspace_id`, `is_current`, statuses and hashes.
- Preview of a Step 12 version reads only allowlisted content types
  (`html/css/js/svg/txt/xml`) out of its workspace; `build.json` and
  `build-errors.json` are never served, and no database/environment files can
  be reached through preview.

## Deriving a current version to use

Use `getCurrentWebsiteVersion(leadId)` or the API
`GET /api/admin/website-projects/[leadId]/current`. The current version is the
only one permitted for later promotion to live deployment (Step 13) — its
`workspace_id` and `artifact_hash` fully describe what was shipped.

## APIs (read-only, authenticated)

- `GET /api/admin/website-projects/[leadId]` → `{ project, versions, currentVersion }`
- `GET /api/admin/website-projects/[leadId]/versions` → `{ versions }`
- `GET /api/admin/website-projects/[leadId]/current` → `{ currentVersion }`
- `POST /api/campaigns/website` runs the composite flow and returns
  `{ status, project: { projectId, … }, version, jobId }`.

All require the normal admin session; nothing new is exposed to unauthenticated
callers, and responses include only metadata (workspace/hash/status), never
filesystem paths or environment values.

## Concurrency model

SQLite is a single synchronous connection in this app, and every persistence
write goes through `withTransaction`. Version creation uses the
`UNIQUE (project_id, version)` index plus a bounded retry; promotion runs in a
single transaction guarded by the one-current partial unique index. There is no
process-local mutable counter anywhere — concurrent runs are serialized by the
database and its constraints, not by in-memory state.

## Tests

`tests/website-projects.test.ts` — 41 cases covering: project reuse and 1:1
identity; version numbering, monotonicity and per-project counters; legal
transitions; atomic promotion (single current, demotion, idempotent re-promote,
failed/stopped never current, unbound rejected); workspace isolation and
traversal protection; deterministic/source-changing hashes; the full
coding+QA → promote lifecycle; stop/pause/failure behavior (previous current
intact, no duplicate on resume); authenticated GET APIs; and adversarial
scenarios A–F (concurrent creation, hostile insert of a second current,
workspace escape, hash determinism, duplicate promotion, metadata-only reads).

Full gate: `npx vitest run`, `npm run lint`, `npx tsc --noEmit -p tsconfig.json`,
`npm run build -- --webpack`.

## Out of scope (deliberately)

Deployment/hosting/rollout (Step 13), rollback UI (Step 15), email/outreach,
public URLs, and any new agent loop engine. `createWebsiteVersion` /
`runWebsiteGeneration` (the archived pre-Step-12 flow) remain intact for
compatibility.