# Discovery Pipeline

Campaigns produce deterministic category/location queries. Discovery providers are selected through a capability contract rather than being hard-coded into orchestration.

The standard Brave adapter may run searches when configured, but candidate persistence is blocked unless `BRAVE_PERSISTENCE_ALLOWED=true`. This keeps the implementation usable for diagnostics while preventing the bot from silently turning a capability/terms mismatch into persistent production data.

After a provider result is accepted for persistence, the candidate store normalises the public website domain, checks durable `do_not_crawl` suppression and deduplicates by canonical domain. The supplier's own website will be the primary evidence source for later profile research.
