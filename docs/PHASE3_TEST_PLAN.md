# Phase 3 regression test plan

The Phase 3 implementation must pass the repository's full required CI. Dedicated tests additionally verify:

- the validator refuses to operate unless the Shadow safety contract is intact;
- reporting calculates yield, quality, evidence coverage, duplicate counts and AI cost deterministically;
- the 100-candidate threshold transitions acquisition to draining;
- the Control Centre exposes Phase 3 telemetry;
- the CLI report remains available;
- `do_not_list` suppression is checked before and immediately before EventFlow publication;
- existing HMAC, compliance and publication gates remain intact.
