# Hosting & Deployment prototype

An isolated, mobile-first UI/UX prototype showing how generated websites could be deployed
through a **provider adapter contract**. Route: **`/prototype/hosting`**
(`npm run dev`, then `http://localhost:3000/prototype/hosting`).

Access is inherited from the app: `src/proxy.ts` redirects anonymous visits to
`/login?next=/prototype/hosting`, so reviewing it needs a normal signed-in session. The
prototype adds no auth code and touches no session state.

## What this is not

| Guarantee | How it is enforced |
| --- | --- |
| No shell commands are executed | The "terminal" is a `<div>` of strings. No `child_process`, `exec`, or spawn exists anywhere in the folder. |
| No provider API is contacted | No `fetch`, `axios`, or provider SDK. Every value comes from the adapters' in-memory data. |
| No credentials or tokens | Connection state is a string plus a display-only account label. Nothing is read from env, storage, or a cookie. |
| No real deployment | Runs are scripted narration plus in-memory records. |
| No automatic deployment | A run starts only from the Deploy button — no timers, webhooks, or schedulers. |
| No reachable host | Every URL lives on `*.example.test` (reserved by RFC 6761, never resolves). Opening one is behind a confirmation dialog. |
| Nothing outside this folder changes | This folder imports nothing from `@/lib` or `@/app`, and nothing outside imports it. |

The banner and the console footer say all of this on screen, because the worst failure mode for
this UI is someone mistaking simulated output for a real deployment.

## Naming note

The main app has its own `HostingProvider` interface in `src/lib/deployment/types.ts` — that one
hosts *agent jobs* on long-running processes, a different concern. It is **not imported here**.
To keep the two from ever being confused, the prototype's descriptor type is called
`PrototypeDeploymentProvider` and its contract is `DeploymentProviderAdapter`.

## File map

```
src/app/prototype/hosting/
├── page.tsx                         Route entry + metadata
├── hosting-client.tsx               Registry host + keyed per-provider workspace
├── types.ts                         Domain model (no provider-specific behaviour)
├── provider-contract.ts             The adapter contract, typed results, failure injector
├── README.md
├── lib/
│   ├── status.ts                    Status / connection / failure metadata, progress, phases
│   ├── format.ts                    Date, duration, host, version formatting
│   ├── use-provider-deployment-session.ts   Session hook: loads, streams, confirms, stops
│   ├── simulation/
│   │   ├── lifecycle.ts             Scripted deploy / stop / connect / disconnect narration
│   │   ├── mock-urls.ts             Mock URLs on the reserved `.example.test` domain
│   │   └── mock-site.ts             The generated website every adapter is asked to publish
│   └── providers/
│       ├── base-provider-adapter.ts Shared simulated adapter implementation
│       ├── vercel-adapter.ts        Vendor A: connected, v3 live, v2 failed
│       ├── netlify-adapter.ts       Vendor B: auth required, v2 live, v1 stopped
│       ├── cloudflare-pages-adapter.ts  Vendor C: not connected, nothing deployed
│       ├── custom-vps-adapter.ts    Vendor D: connected, cannot cancel a run (canStop: false)
│       └── index.ts                 Provider catalog + adapter registry
└── components/
    ├── prototype-banner.tsx         "Simulated UI" notice
    ├── prototype-controls.tsx       Demo-only failure injection + adapter reset
    ├── provider-selector.tsx        Provider picker; shows the active adapter + capabilities
    ├── connection-state.tsx         not connected → authentication required → connected
    ├── website-info-card.tsx        Business name, version, project ID, last deploy, URL
    ├── deployment-status-card.tsx   Status, progress, 4-phase timeline, injection notice
    ├── deployment-controls.tsx      Deploy / Redeploy / Stop / View Live Site / Logs + mobile bar
    ├── confirm-dialog.tsx           Confirmation modal for destructive actions
    ├── terminal-panel.tsx           Simulated terminal console
    ├── logs-panel.tsx               Timestamped logs with level filters
    ├── deployment-history.tsx       Per-provider version history with actions
    ├── mock-url.tsx                 Renders a URL with a "mock" marker
    ├── status-badge.tsx / panel.tsx / button.tsx   Shared primitives
```

## Adapter architecture

Three layers, so a UI change never touches data and a data change never touches UI:

1. **Presentational components** take plain props. `DeploymentStatusCard` renders whatever
   status it is handed; nothing in `components/` knows a provider exists.
2. **`useProviderDeploymentSession(adapter)`** owns behaviour for one provider: loading,
   the deployment lifecycle, streamed output, Stop, and reconciliation.
3. **`DeploymentProviderAdapter`** (`provider-contract.ts`) is the boundary. Each provider has
   one implementation; `SimulatedProviderAdapter` holds the shared simulated behaviour, and the
   four vendor files are configuration (CLI voice, capabilities, seed history).

```
HostingPrototype            owns: adapter registry, demo failure injector, connection snapshots
 └─ PrototypeBanner / PrototypeControls
 └─ ProviderWorkspace [key=providerId:epoch]
      ├─ useProviderDeploymentSession(adapter)
      ├─ ProviderSelector · ConnectionStateCard
      ├─ DeploymentStatusCard · WebsiteInfoCard · DeploymentControls
      └─ TerminalPanel · DeploymentLogsPanel · DeploymentHistory
```

### The contract

Every method returns a typed result instead of throwing, so failure paths are part of the
contract and every response is stamped `simulated: true`:

```ts
type AdapterResult<T> =
  | { ok: true;  simulated: true; data: T }
  | { ok: false; simulated: true; error: AdapterError };   // code, message, retryable

interface DeploymentProviderAdapter {
  readonly providerId; readonly providerLabel; readonly adapterLabel;
  readonly capabilities: ProviderCapabilities;   // canDeploy / canRedeploy / canStop / custom domain

  // authentication
  getConnectionState(): Promise<AdapterResult<ProviderConnection>>;
  connect():   Promise<AdapterResult<AuthHandshakeResult>>;   // steps, pending, result, succeeded
  disconnect(): Promise<AdapterResult<DisconnectResult>>;

  // deployment
  deploy(request):   Promise<AdapterResult<DeploymentRunPlan>>;  // steps, stopSteps, expectedOutcome
  redeploy(request): Promise<AdapterResult<DeploymentRunPlan>>;
  stop(runId, context): Promise<AdapterResult<DeploymentOutcome>>;
  getDeploymentStatus(runId): Promise<AdapterResult<DeploymentStatusSnapshot>>;

  // reads
  getWebsite(); getLogs(deploymentId); getDeploymentHistory(projectId); getPublicUrl(deploymentId?);

  // console + bookkeeping
  getSessionIntro(): Promise<AdapterResult<LogEntry[]>>;
  reportRunResult(runId, { outcome, logs }): Promise<AdapterResult<DeploymentRecord>>;
}
```

`DeploymentRunPlan` is what makes the mock feel alive: the adapter hands the UI scripted output
**plus** the lifecycle transitions it implies, and the session hook replays them. A real adapter
returns the same shape with empty `steps` and a live log stream instead.

### Provider switching

`createPrototypeProviders()` builds one adapter per provider. `HostingPrototype` keeps them in a
registry, and `ProviderWorkspace` is **keyed by provider id** — switching providers remounts the
workspace with a different adapter, so two providers' state can never mix, and not one component
is duplicated per provider. The picker shows each provider's adapter label plus which capabilities
it supports (`stop` is struck through for Custom/VPS), and the connection badge comes from that
adapter's `getConnectionState()`.

Each adapter starts in a different, realistic state, so the same screen demonstrates every state:

| Provider | Connection | History | Notes |
| --- | --- | --- | --- |
| Vercel | connected | v3 live, v2 failed, v1 superseded | happy path, Redeploy reachable |
| Netlify | authentication required | v2 live, v1 stopped | must run the handshake before deploying |
| Cloudflare Pages | not connected | none | **not deployed** path from scratch |
| Custom / VPS | connected | v1 live | `canStop: false`, so Stop is hidden and explained |

## Provider lifecycle

```
deploy(): getWebsite → deploy/redeploy(request)
          → status preparing → building → deploying → live
          → reportRunResult(outcome, streamed logs)
          → getDeploymentStatus(runId)        ← provider is the source of truth
          → getDeploymentHistory + getWebsite ← refresh the view
```

- **Statuses**: `not_deployed → preparing → building → deploying → live`, plus `failed` and
  `stopped`. Only the three active states allow Stop; the timeline marks the phase a failure or
  stop happened at (`phaseAtFailure`).
- **Logs during the run**: scripted steps are appended to the console *and* to the selected
  deployment's log list, so the logs panel streams while the terminal narrates.
- **Stop**: cancel the in-flight narration → stream the stop narration → call
  `stop(runId, { logs, durationMs })` → append the provider's answer → `reportRunResult`.
  The final `stopped` transition is owned by the session, **not** the narration, so a provider
  that refuses to cancel (Custom/VPS) reports honestly instead of the UI pretending it stopped.
- **No hidden work**: nothing polls in the background and nothing retries on its own.

## Authentication simulation

`not_connected → auth_required → connected`, with every transition logged:

```
$ vercel login
Opening Vercel authorization (simulated)...
Authentication required — approve the request in the provider dashboard. No browser window opens here.
> Waiting for authentication...
Received an authorization code (simulated). Exchanging it for a session...
✓ Connected as brightside-dental (team)
# No token was stored: this prototype keeps the connection in memory for this page only.
```

`connect()` returns the `pending` connection (so the card really passes through
"Authentication required"), the streamed steps, and the final `result`. Step-level
`connectionState` values are applied by the session through `getConnectionState()`, which is why
the badge, the picker, and the console never disagree.

## Failure simulation (demo only)

`PrototypeControls` arms a one-shot failure for the next provider operation:

| Armed | Effect |
| --- | --- |
| Build failure | Next deploy stops during `building`, status `failed` |
| Deployment failure | Next deploy stops during `deploying` (upload rejected, HTTP 500) |
| Authentication failure | Next deploy **or** connect fails, status `failed`, and the adapter's connection flips to `auth_required` |
| No failure | Happy path |

The injection lives in `createSimulationHarness()` (a tiny object outside React, so adapters
always read the live value) and is **consumed** by whichever operation uses it — so the flow
"arm → Deploy → fails → Retry (now unarmed) → live" works without touching the toggle, which is
exactly the retry path a real integration needs. `Reset all adapters` rebuilds the registry and
clears every provider's state.

## How a real provider adapter replaces a mock

Write one class implementing `DeploymentProviderAdapter` and swap it in `lib/providers/index.ts`.
No component, no hook, and no layout changes:

```ts
export class VercelDeploymentAdapter implements DeploymentProviderAdapter {
  readonly providerId = "vercel";
  readonly providerLabel = "Vercel";
  readonly adapterLabel = "Vercel adapter";
  readonly capabilities = { canDeploy: true, canRedeploy: true, canStop: true, supportsCustomDomain: true };

  async getConnectionState() { return ok(await getJson("/api/hosting/providers/vercel")); }
  async connect()            { return ok(await getJson("/api/hosting/providers/vercel/connect")); }
  async deploy(request)      { return ok(await postJson("/api/hosting/deployments", request)); }
  async stop(runId, ctx)     { return ok(await postJson(`/api/hosting/deployments/${runId}/stop`, ctx)); }
  async getDeploymentStatus(runId) { return ok(await getJson(`/api/hosting/deployments/${runId}`)); }
  async getLogs(id)          { return ok(await getJson(`/api/hosting/deployments/${id}/logs`)); }
  async getDeploymentHistory(projectId) { return ok(await getJson(`/api/hosting/deployments?projectId=${projectId}`)); }
  async getPublicUrl(id?)    { return ok(await getJson(`/api/hosting/public-url${id ? `?id=${id}` : ""}`)); }
  async getSessionIntro()    { return ok([]); }
  async reportRunResult(runId, result) { return ok(await patchJson(`/api/hosting/deployments/${runId}`, result)); }
  async disconnect()         { return ok(await postJson("/api/hosting/providers/vercel/disconnect", {})); }
}
```

Then:

- **Log streaming** — return `steps: []` from `deploy` and have the session poll
  `getDeploymentStatus` / `getLogs` (or consume SSE) instead of `playSteps`. The lifecycle
  transitions come from the provider's status field rather than from scripted steps.
- **Status changes from webhooks** — point `getDeploymentHistory` at the server's deployment
  table and they appear with no UI change; the session only reacts to what the adapter reports.
- **Errors** — return `{ ok: false, error: { code, message, retryable } }` and the UI shows the
  message, and offers Retry only when `retryable` is true.
- **Capabilities** — a provider without cancellation sets `canStop: false` and the Stop button
  disappears on its own, exactly as Custom/VPS already demonstrates.

## Where authentication would eventually live

Not in this folder. The browser must never hold a provider token:

1. `connect()` calls an authenticated internal route (`POST /api/hosting/providers/:id/connect`).
2. That route starts the provider's OAuth/device flow server-side and stores the token in the
   server's secret store, scoped to the workspace.
3. It returns only the state, account label, and scopes — the `ProviderConnection` shape.
4. `getConnectionState()` reflects the stored session and can report `auth_required` when refresh
   fails, which is the state the UI is already designed around.
5. `disconnect()` revokes the token and deletes the stored secret.

The prototype's `pending` state maps to "authorization started, waiting for callback", so the UI
already has a place to show that without a redesign.

## Security considerations

- **Tokens never reach the browser.** The contract deliberately carries no credential field;
  keep it that way. `accountLabel` and `scopes` are display data only.
- **CSRF/origin checks** belong on the mutating routes (deploy, stop, connect, disconnect) — the
  app's proxy already enforces same-origin for non-GET `/api/*` requests, and any new routes
  must keep that property.
- **Authorization, not just authentication.** Deploying a website is a write with a public
  effect; routes must verify the session may act on that project.
- **Idempotency + a per-project lock.** Two admins pressing Deploy must not race; pass an
  idempotency key and refuse concurrent runs.
- **Audit every action.** Deploy, stop, connect, and disconnect need records with actor and
  timestamp; the prototype keeps history visible for the same reason.
- **Failure contract.** A failed build must never take the live version offline. The UI asserts
  this, but the server is what guarantees it.
- **Route placement.** This page relies on the global proxy for access control. When it stops
  being a prototype, move it under the real admin area (or delete it).
- **Don't leak provider errors.** Surface a mapped, user-safe message; keep raw provider
  responses server-side.

## Intentionally unimplemented

- No real provider SDK, OAuth flow, token storage, or webhook handling.
- No persistence: closing the page forgets every adapter (there is no database involved).
- No background polling, auto-retry, or scheduled deploys.
- No env-var or config plumbing for provider credentials.
- No custom-domain DNS verification flow (`supportsCustomDomain` is descriptive only).
- No multi-user concurrency handling, audit table, or rate limiting — see the security section.
- Railway, Fly.io, and Render appear in the picker as "coming soon" with no adapter.
