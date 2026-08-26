# Phase 3 — Shadow Validation

Phase 3 validates the real South Wales venue pipeline before any production publication or outreach is allowed.

## Safety contract

The validator only activates when all of the following are true:

- operating mode is `shadow`;
- EventFlow publishing is off;
- marketing/outreach is off;
- claim notices are off;
- SEO indexing is off.

If any of those controls are enabled, the Phase 3 validator refuses to start or advance.

## Validation sample

The first Phase 3 run targets **100 real candidates**, the lower bound of the planned 100–250 candidate validation range. The run is created automatically by the existing system reconciler the first time the bot is actually running under the Phase 3 safety contract.

The run records its own `startedAt` timestamp and active campaign id, so older Phase 1 records do not contaminate the Phase 3 sample.

At 100 candidates the validator automatically switches the bot to `draining`. That stops new discovery while allowing already-admitted crawl/extraction/compliance work to finish. The existing drain reconciler then stops the bot when queues are empty. On the following reconciliation the validation run is marked complete.

## Metrics captured

The Phase 3 report measures:

- candidates acquired;
- Shadow profile yield;
- average publication quality;
- average data confidence;
- evidence coverage;
- public email and phone extraction coverage;
- advertised-price coverage;
- package extraction coverage;
- distinct / probable duplicate / strong duplicate outcomes;
- quarantined and rejected candidates;
- publication-eligible, review and blocked outcomes;
- SEO-ready outcomes (measurement only — SEO remains disabled);
- cumulative OpenAI estimated cost during the run;
- estimated AI cost per acquired candidate.

These are tuning signals rather than invented pass/fail percentages. The hard acceptance gates in Phase 3 are the safety contract and completion of the real-candidate sample. Accuracy thresholds should be tuned from the observed data before Phase 4.

## Reporting

After building the project, run:

```bash
npm run phase3:report
```

The command prints the current Phase 3 run and metrics as JSON. It is safe to run while the bot is active.

## Production sequence

1. Deploy the merged Phase 2 sender and receiver.
2. Configure the shared EventFlow HMAC secret and EventFlow base URL in Railway.
3. Keep Supplier Bot publishing, marketing, claim notices and SEO indexing off.
4. Keep mode set to `shadow`.
5. Start the existing South Wales Venues campaign.
6. The validator records the start automatically and counts only candidates discovered from that point.
7. At 100 candidates it automatically drains and stops new acquisition.
8. Run `npm run phase3:report` and review/tune extraction, quality, dedupe, compliance and cost behaviour before Phase 4.

No Phase 3 code enables EventFlow publication, outreach, claiming or search-engine indexing.
