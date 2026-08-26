# Phase 1 Acceptance

Phase 1 is complete when the standalone bot can be configured through the Control Centre with a campaign such as `Venues · South Wales · target 10/day · hard max 10/day` and autonomously:

1. discover candidate supplier websites through a permitted provider,
2. suppress and deduplicate candidates,
3. crawl only safe public web destinations,
4. prioritise useful supplier pages,
5. extract deterministic facts before AI,
6. retain compact evidence/provenance,
7. enrich with structured extraction/AI where needed,
8. produce explainable quality scores,
9. persist complete Shadow profiles,
10. recover/retry/quarantine routine failures without operator action.

No EventFlow production write path is permitted in Phase 1.
