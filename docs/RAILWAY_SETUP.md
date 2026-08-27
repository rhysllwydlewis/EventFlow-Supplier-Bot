# Railway Setup

Use the same Railway project/environment as EventFlow, but keep Supplier Bot data services isolated from EventFlow's application stores.

## Services

- `supplier-bot-control` — this repo using the root `Dockerfile`, start `npm run start:control`, public domain enabled, health path `/health`.
- `supplier-bot-worker` — this repo using the same root `Dockerfile`, override the start command to `npm run start:worker`, no public domain.
- dedicated Redis for the Supplier Bot.
- dedicated MongoDB for the Supplier Bot.

The Dockerfile pins Node 22, installs Playwright Chromium plus Linux dependencies, and runs the application as the non-root `node` user. Railway should detect the root Dockerfile automatically; no Railpack build command is required.

Use Railway private reference variables for Mongo/Redis. For Redis/ioredis the code sets `family: 0` to support Railway's dual-stack private networking.

The Control Centre needs `CONTROL_ADMIN_KEY` and a different `CONTROL_SESSION_SECRET`. Provider/API secrets belong in Railway variables, never GitHub.

Browser fallback uses Chromium only for JS-heavy sites. Keep `BROWSER_ALLOW_NO_SANDBOX=false` initially. If Railway's worker runtime specifically rejects Chromium sandbox startup, change only that worker variable to `true` after checking the worker logs; the browser still runs inside the isolated worker service with public-network request guards and concurrency 1.

## Phase 2 EventFlow integration variables

Supplier Bot services require:

- `EVENTFLOW_INTERNAL_BASE_URL=https://event-flow.co.uk`
- `EVENTFLOW_BOT_HMAC_SECRET=<the same strong random secret configured on EventFlow>`

EventFlow itself requires:

- `EVENTFLOW_BOT_HMAC_SECRET=<the same shared secret>`
- `SUPPLIER_BOT_INGESTION_ENABLED=true`

The HMAC secret is credentials material. Store it only as a Railway variable and rotate it in both systems together if it is ever exposed.

`publishingEnabled` is **not** an environment variable. It is a runtime Control Centre setting shown as the **Publishing** checkbox under **Operating settings**.

## Phase 3 Shadow validation settings

Phase 3 must run with:

- Mode: `shadow`
- Discovery: on
- Refresh: on
- Publishing: **off**
- Claim notices: **off**
- Marketing: **off**
- SEO indexing: **off**
- South Wales Venues pilot: target 10/day, hard max 10/day

The Phase 3 validator refuses to advance unless all outbound controls remain off. It records a fresh run window automatically and drains acquisition when the first 100 real candidates have been collected.

The Control Centre exposes a **Phase 3 · Shadow validation** panel with progress, quality, evidence, duplicate rate, AI cost and safety state. The same data is available from the authenticated `/api/phase3-validation` endpoint.

After build/deploy, `npm run phase3:report` prints the current validation report as JSON from the bot MongoDB.

## Deployment checks

1. `supplier-bot-control` is Active, has a public domain, and `/health` plus `/ready` succeed.
2. `supplier-bot-worker` is Active with no public domain and appears as a fresh healthy worker in the Control Centre.
3. dedicated bot MongoDB and Redis remain separate from EventFlow's existing stores.
4. EventFlow integration reports **configured** in the Control Centre once the base URL and HMAC secret are present.
5. the bot remains in Shadow mode with Publishing, claim notices, Marketing and SEO indexing off throughout Phase 3.
6. provider secrets required for autonomous discovery/enrichment are present in Railway.
7. the Phase 3 panel shows the safety contract as healthy before pressing **Run**.
