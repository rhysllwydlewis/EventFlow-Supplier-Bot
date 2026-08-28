# EventFlow Supplier Bot

Standalone autonomous supplier discovery and Shadow-profile composition service for EventFlow.

## Phase 1 status

The bot can run independently of EventFlow production. It supports campaign planning, bounded discovery, suppression/deduplication, safe HTTP crawling, JS-heavy-site browser fallback, deterministic extraction, evidence-bound AI enrichment, quality/compliance scoring, Shadow reviews, retries and reconciliation.

There is intentionally no EventFlow production write path until Phase 2.

## Services

- `supplier-bot-control` — authenticated Control Centre and status API.
- `supplier-bot-worker` — BullMQ orchestration, discovery, HTTP crawl and Playwright fallback workers.
- dedicated MongoDB and Redis.

## Local setup

Copy `.env.example`, provide local MongoDB/Redis and strong control secrets, then:

```bash
npm install
npm run install:browser
npm run build
npm run start:control
# separate process
npm run start:worker
```

`playwright` is pinned to an exact version in `package.json` (no `^` range, unlike every other dependency) because the Chromium build `npm run install:browser` downloads is tied to that exact package version -- installing a newer `playwright` without also re-running `install:browser` (or vice versa) leaves the two out of sync. `npm ci` (used in CI and the Dockerfile) against the committed `package-lock.json` keeps this exact.

Default operating posture is Shadow mode, stopped, with publication/outreach/SEO indexing disabled.

See `docs/PHASE1_COMPLETE.md`, `docs/CRAWLER_POLICY.md` and `docs/RAILWAY_SETUP.md` for the operating and deployment contracts.
