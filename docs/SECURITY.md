# Security Boundaries

- The bot database is isolated from EventFlow production data.
- The bot never receives EventFlow MongoDB credentials.
- Phase 2 writes go through a narrow private HMAC/idempotent EventFlow API.
- The standalone Control Centre requires a signed HttpOnly SameSite=Strict session and CSRF token for state changes.
- Runtime secrets live in Railway variables, never GitHub.
- AI models will receive evidence only; they will not receive database, mail, shell, browser-control or EventFlow credentials.
- Crawling will reject non-HTTP(S), loopback, private, link-local, metadata and Railway-private destinations, with DNS/redirect revalidation.
- Durable suppression is checked before crawling/listing/contacting.
- Emergency Stop disables publishing/marketing/indexing and pauses pipeline queues while leaving orchestration available for recovery.
