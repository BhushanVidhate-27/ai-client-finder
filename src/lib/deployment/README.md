# Hosting Deployment Engine (Step 13)

Deploys a **verified current website version** to a hosting provider. There is
no auto-deploy: every deployment requires explicit human approval from the
admin UI, and only the currently-verified version can be deployed.

## Hardware constraints (unchanged from Step 9)

- No shell / `child_process()` anywhere in the deployment code.
- No rollback logic.
- No emailing, no outbound reach-out of any kind.
- The database is the source of truth for all deployment state.
- Credentials come from server-side environment variables only. They are never
  logged, never written into website source/artifacts, and never returned by
  any API route.

## Providers

| Provider    | Env variables                                  | Notes                                      |
| ----------- | ---------------------------------------------- | ------------------------------------------ |
| `vercel`    | `VERCEL_TOKEN`                                 | REST API, sync upload (`createDeployment`) |
| `netlify`   | `NETLIFY_TOKEN`, `NETLIFY_SITE_ID` (optional)  | REST API; file count limit is surfaced     |
| `cloudflare`| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`| Pages direct-upload (last deployed snapshot, no sync-URL crawl) |
| `mock`      | `MOCK_DEPLOYMENTS=1`                           | Dev/test only; clearly labelled in the UI  |

The registry (`registry.ts`) only registers a provider when it is configured.
`mock` is registered only when `MOCK_DEPLOYMENTS=1`.

## Deployment state machine

```
pending -> validating -> uploading -> building -> deploying -> ready
   |            |             |             |             |
   v            v             v             v             v
 failed        failed       failed        failed        failed
   ^            ^             ^             ^             ^
   +------------+-------------+-------------+-------------+
   (any active state may also go to cancelled)
ready is terminal; uploading -> ready is not a legal transition (the flow
walks the chain with advanceDeploymentStatusTo before writing a terminal
state).
```

Each transition is persisted with `updateDeploymentRecord`; status reads always
come from the database, never from the wire.

## Deployment flow

`src/lib/jobs/website-deployment-flow.ts` — `runWebsiteDeployment(input, options)`:

1. Checkpoint.
2. `verifyVersionEligible(leadId, versionId)` — the version must be the
   project's **current**, `success`-built, **QA-pass** version, the build
   artifact hash must be present, and re-hashing the persisted workspace must
   match (`deployment.verify_immutable`). Otherwise the job fails with
   `DeploymentIneligibleError`.
3. Package the workspace into a deterministic artifact (files sorted, SHA-256
   hash). Excluded: dotfiles, `.env*`, `build.json`, `build-errors.json`,
   `.db/.sqlite/.key/.pem/.crt`.
4. Create the `deployments` record (`pending`, concurrency-guarded: at most one
   active deployment per project) and immediately mark it `validating`.
5. Validate the provider connection (`validateConnection`) — failure marks the
   record `failed` (never leaves zero records behind).
6. Run the Website Deployer agent loop (`src/lib/website-deployer/agent.ts`)
   with tools `deployment.deploy`, `deployment.status`, `deployment.verify_immutable`.
7. On terminal success the record is marked `ready`; on error/watchdog it is
   marked `failed`; on a user stop it is marked `cancelled` and the provider is
   asked to cancel if supported.

`pollDeploymentUntilTerminal` wraps provider polling with `MAX_POLL_ATTEMPTS=60`
at `POLL_INTERVAL_MS=2000`; exceeding `DEPLOYMENT_TIMEOUT_MS` marks the record
failed.

## Agent catalog entry

The `deployment` entry in the agent registry is metadata (`status: "planned"`).
The real runner is constructed per run inside the flow because it needs the
resolved provider adapter and state dependencies.

## Cancellation

`POST .../deployments/[deploymentId]/cancel` (admin, checked):
- In-flight job -> cooperative stop (`controller.requestStop()`); the flow's
  `stopped` branch updates the record to `cancelled` and calls
  `adapter.cancelDeployment` when `supportsCancel` is true.
- Stale/queued record -> `markDeploymentCancelled` + provider cancel directly.

## API surface

- `POST /api/admin/website-projects/[leadId]/deployments` — body `{provider, versionId}`.
- `GET  /api/admin/website-projects/[leadId]/deployments` — list for a lead.
- `GET  /api/admin/website-projects/[leadId]/deployments/[deploymentId]` — one record.
- `GET  /api/admin/website-projects/[leadId]/deployments/[deploymentId]/status` — live status.
- `POST /api/admin/website-projects/[leadId]/deployments/[deploymentId]/cancel`.
- `GET  /api/admin/deployment/providers` — configured providers + connection state.
- History lead detail includes `deployments`.

## UI

`/history?lead=<id>` → Lead detail pane → **Deploy** section: provider select,
Deploy (runs the flow in the job queue), live status badges, Cancel while a
deployment is active, and the review link once `ready`. `/home` leads table has
a **Deploy** link into that panel.