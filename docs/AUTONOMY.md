# Autonomy Contract

The bot is designed so normal operation does not require per-supplier approval or routine operator intervention.

## The bot must resolve routine situations itself

- transient provider/network failures: retry with bounded backoff
- abandoned/stale work: reconcile and reclaim safely
- duplicate candidates: collapse by canonical business identity
- suppressed businesses: never re-create/re-contact contrary to suppression state
- incomplete evidence: omit unsupported fields rather than inventing them
- provider capability mismatch: refuse that capability or use another configured provider
- quality below threshold: keep in shadow/quarantine rather than publish
- daily/cost ceilings: slow or stop the relevant stage automatically
- drain request: finish safe in-flight work then transition itself to stopped

## The bot must stop or degrade safely

Circuit breakers will pause only the affected pipeline where possible when failure, duplicate, spend, extraction or publication metrics move outside configured tolerances.

## Human intervention is exceptional

Human review is reserved for genuinely ambiguous legal/ownership/dispute cases or strategic configuration changes, not ordinary supplier processing.
