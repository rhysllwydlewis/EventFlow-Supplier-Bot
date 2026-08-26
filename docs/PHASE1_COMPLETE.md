# Phase 1 Complete — Standalone Supplier Bot

Phase 1 is complete when PR #6 is merged with CI/review green.

The standalone bot can be operated from the Control Centre in Shadow mode and autonomously:

1. plan category/location campaigns and enforce daily hard caps,
2. discover candidates through capability-gated providers or safe manual seed,
3. apply durable suppression and canonical-domain deduplication,
4. crawl only validated public HTTP(S) destinations with SSRF/redirect/body/time limits,
5. prioritise useful supplier pages rather than crawling entire sites,
6. extract deterministic facts before AI,
7. store compact evidence/provenance rather than whole websites,
8. use evidence-only Structured Outputs AI enrichment with budget/circuit-breaker fallback,
9. score profile quality and deterministic compliance separately from SEO readiness,
10. deduplicate supplier identity across different domains using public business identity signals,
11. mark strong identity duplicates automatically and quarantine ambiguous probable duplicates,
12. reconcile historical Shadow profiles into the identity index automatically,
13. expose operating controls, costs, queues, candidate states and Shadow reviews in the Control Centre,
14. retry/reconcile/quarantine routine failure states without requiring per-supplier approval.

## Phase boundary

There is deliberately no EventFlow production write path in Phase 1. Ownerless/unclaimed supplier creation, EventFlow ingestion, claim verification, package handover and production publishing begin in Phase 2.

## Initial operating preset

- Mode: Shadow
- Category: Venues
- Area: South Wales
- Daily target: 10
- Daily hard maximum: 10
- Outreach: Off
- EventFlow publication: Off
- SEO indexing: Off
