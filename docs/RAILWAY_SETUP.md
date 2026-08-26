# Railway Setup (Phase 1)

Use the same Railway project/environment as EventFlow, but create separate bot data services.

## Services

- `supplier-bot-control` — this repo using the root `Dockerfile`, start `npm run start:control`, public domain enabled, health path `/health`.
- `supplier-bot-worker` — this repo using the same root `Dockerfile`, override the start command to `npm run start:worker`, no public domain.
- dedicated Redis for the Supplier Bot.
- dedicated MongoDB for the Supplier Bot.

The Dockerfile pins Node 22, installs the Playwright package's Chromium browser plus Linux dependencies, and runs the application as the non-root `node` user. Railway should detect the root Dockerfile automatically; no Railpack build command is required.

Use Railway private reference variables for Mongo/Redis. For Redis/ioredis the code sets `family: 0` to support Railway's dual-stack private networking.

The Control Centre needs `CONTROL_ADMIN_KEY` and a different `CONTROL_SESSION_SECRET`. Provider/API secrets belong in Railway variables, never GitHub.

Browser fallback uses Chromium only for JS-heavy sites. Keep `BROWSER_ALLOW_NO_SANDBOX=false` initially. If Railway's worker runtime specifically rejects Chromium sandbox startup, change only that worker variable to `true` after checking the worker logs; the browser still runs inside the isolated worker service with public-network request guards and concurrency 1.

Before Phase 2, verify:

1. `supplier-bot-control` is Active, has a public domain, and `/health` plus `/ready` succeed.
2. `supplier-bot-worker` is Active with no public domain and appears as a fresh healthy worker in the Control Centre.
3. dedicated bot MongoDB and Redis remain separate from EventFlow's existing stores.
4. the bot remains in Shadow mode with the South Wales Venues pilot at target 10/day and hard max 10/day.
5. outreach, EventFlow publication, and SEO indexing remain off.
6. provider secrets required for autonomous discovery/enrichment are present in Railway.

Phase 1 does not configure EventFlow ingestion variables. `EVENTFLOW_INTERNAL_BASE_URL` and `EVENTFLOW_BOT_HMAC_SECRET` remain unset until Phase 2.
