# Delivery Phases

## Phase 0 — Foundation

Repository scaffold, CI, typed configuration, security boundaries, Mongo/Redis isolation, control/worker service split and architecture documentation.

## Phase 1 — Standalone Supplier Bot

Control Centre, campaigns, discovery abstraction, crawling, extraction, provenance, deduplication, compliance, quality, cost controls, retries/reconciliation and shadow profile previews. No EventFlow production writes.

Initial preset: Venues · South Wales · target 10/day · hard max 10/day · Shadow mode · publishing/outreach/SEO indexing off.

## Phase 2 — EventFlow integration

Ownerless/unclaimed supplier fields, dedicated import services, private HMAC/idempotent ingestion API, claim flow, normal-signup collision detection, package grace, suppression and bot-specific SEO gates.

## Phase 3 — Validation and optimisation

Run 100–250 real venue candidates in Shadow mode and tune accuracy, dedupe, pricing/package extraction, evidence quality, costs and failure handling.

## Phase 4 — Controlled production pilot

Venues · South Wales · 10/day maximum · outreach off · Google indexing off, starting with canary publication.

## Phase 5 — Claim lifecycle validation

Validate domain email, known business email, DNS/website proof, phone fallback, duplicate signup, competing claims, abandoned claims, disputes and package handover.

## Phase 6 — Scale

Expand supplier categories and volume only when quality metrics remain healthy.

## Phase 7 — Autonomous coverage

EventFlow coverage signals drive campaign priorities automatically; the bot chooses what and where to acquire within strategic and safety limits.
