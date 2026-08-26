# Implementation Progress

## Phase 0 / early Phase 1 — in progress

Implemented on `phase-0-foundation`:

- Node 22 + strict TypeScript scaffold
- CI workflow
- isolated MongoDB + indexes
- isolated Redis + BullMQ queue namespace
- Control Centre and worker process split
- signed HttpOnly control session + CSRF protection
- Shadow/stopped safe defaults
- South Wales Venue Pilot (10 target / 10 hard maximum)
- runtime guardrails and absolute ceilings
- Play / Pause / Drain / Emergency Stop
- worker/control heartbeats and queue health
- autonomous drain reconciler
- campaign persistence
- audit trail
- candidate lifecycle and canonical-domain dedupe
- durable do-not-crawl/list/contact suppression
- discovery provider capability contract
- Brave adapter with persistence gate
- deterministic category/location query generation
- provider usage accounting foundation
- Control Centre web UI

Next:

- live crawler and SSRF protections
- page selection / sitemap / robots policy
- Playwright fallback worker
- deterministic website extraction
- OpenAI structured extraction
- evidence/provenance store
- profile/package composer and shadow preview
- quality/circuit breaker engine
- EventFlow ingestion and claim flow (Phase 2)
