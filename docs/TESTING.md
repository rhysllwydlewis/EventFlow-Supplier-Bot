# Testing Strategy

The repository uses Vitest for deterministic units and GitHub Actions on Node 22 for lint/typecheck/test/build verification.

Current tests lock:

- safe Shadow/stopped defaults and 10/day venue pilot
- URL/domain canonicalisation
- discovery query construction
- provider capability contract
- crawler SSRF network policy
- useful-page selection

Later suites will add fixture-based HTML extraction, redirect/DNS security cases, duplicate/suppression integration tests, AI schema fixtures, quality/circuit-breaker tests and EventFlow staging ingestion tests.
