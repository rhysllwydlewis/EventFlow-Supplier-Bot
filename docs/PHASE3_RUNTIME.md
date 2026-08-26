# Phase 3 runtime controls

The Phase 3 validator is intentionally fail-closed. It will only create or advance a validation run when all of these are true:

- mode: `shadow`
- run state: `running` to start collection
- Publishing: off
- Claim notices: off
- Marketing: off
- SEO indexing: off

`publishingEnabled` is a persisted Control Centre setting, not a Railway environment variable. It is controlled by the **Publishing** checkbox under **Operating settings**.

The validator counts only fresh candidates discovered at or after its own `startedAt` timestamp. At 100 candidates it changes the bot to `draining`; the existing queue drain then lets in-flight work finish before the bot stops.
