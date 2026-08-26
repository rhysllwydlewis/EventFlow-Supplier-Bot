# Phase 3 completion checklist

Phase 3 is complete only when all of the following are true.

## Code and safety

- [x] Phase 2 EventFlow ingestion remains HMAC signed and publication gated.
- [x] `do_not_list` suppression is checked before and immediately before an EventFlow write.
- [x] Phase 3 only advances in `shadow` mode.
- [x] Publishing is off.
- [x] Claim notices are off.
- [x] Marketing/outreach is off.
- [x] SEO indexing is off.
- [x] A fresh Phase 3 sample window is recorded independently of older Shadow data.
- [x] The validator automatically drains acquisition after 100 fresh candidates.
- [x] Phase 3 metrics are available through the Control Centre API and UI.
- [x] A CLI JSON report is available through `npm run phase3:report`.

## Production validation

- [ ] Phase 2 sender and receiver are deployed from `main`.
- [ ] Railway contains the shared `EVENTFLOW_BOT_HMAC_SECRET` on EventFlow and Supplier Bot.
- [ ] Supplier Bot contains `EVENTFLOW_INTERNAL_BASE_URL=https://event-flow.co.uk`.
- [ ] EventFlow contains `SUPPLIER_BOT_INGESTION_ENABLED=true`.
- [ ] The production Control Centre confirms Shadow mode and all outward-facing switches off.
- [ ] The South Wales Venues campaign is running.
- [ ] 100 fresh real venue candidates have been acquired after the Phase 3 run start time.
- [ ] Queues have drained after the 100-candidate target.
- [ ] The final Phase 3 report has been reviewed for extraction, dedupe, evidence quality, compliance and AI cost.
- [ ] Any observed systematic extraction or dedupe defects have been tuned and the affected checks re-run.

The unchecked items are runtime/deployment evidence, not additional feature scope. They cannot be marked complete from source code alone.
