# Unclaimed Profile Quality Assistant — handoff

Running handoff file for the automated unclaimed-profile quality routine:
mandate, merge/write policy, backlog, a "discovered along the way" list, and
a dated session log. Trust this file over your own assumptions — correct
any entry you find wrong rather than leaving it for a cold session to chase
it.

## Important: this repo is not idle — you are not alone here

Same warning as `docs/devops-assistant-progress.md`: active manual Claude
Code sessions (a different account) also work on this repo. Before touching
anything, check `git log --oneline -20` and open PRs for activity in the
last ~24 hours; leave an area alone this cycle if it looks mid-iteration.

## Mandate

The daily discovery/crawl/publish pipeline creates good candidates overall,
but some published unclaimed profiles are genuinely incomplete: missing
cover or gallery photos, packages with no photo, or thin description/
contact/tag data. This routine's job is to find and fix those — on both
newly-published and long-published profiles — using only real data found on
the supplier's own site. Never invent, guess, or stock-photo a fix; if
nothing real is found for a gap, leave it and log it.

This is a distinct job from `docs/devops-assistant-progress.md`'s general
bug-hunt sweep: that routine finds and fixes problems in this repo's code.
This routine finds and fixes problems in already-published supplier *data*,
using this repo's existing crawl/extraction code as a tool, not something to
change unless a real bug in it is the reason a gap can't be closed.

**First run: build the capability, don't hand-run it from chat.** There is
no re-enrichment workflow yet. Build it properly, the same way
`eventflow-ingestion.service.ts` wraps the create/refresh endpoint:

1. A new `eventflow-quality-audit.service.ts` (or similar) that calls the
   new EventFlow endpoint `POST /internal/supplier-bot/suppliers/audit-queue`
   (HMAC-signed exactly like the existing ingestion/lookup/unpublish calls,
   same `EVENTFLOW_BOT_HMAC_SECRET`). It returns a worst-first, capped batch
   of published unclaimed profiles with real gaps already computed
   (missing cover/gallery images, packages with a placeholder photo, thin
   description, missing phone/email/tags) — don't re-derive completeness
   rules client-side, the endpoint's `gaps` object is the source of truth.
2. A script (`src/scripts/audit-unclaimed-quality.ts`, matching the existing
   `phase3-validation-report.ts` convention) that: pulls the queue, re-crawls
   each flagged supplier's own website with the existing crawler/extraction
   pipeline (respecting `docs/CRAWLER_POLICY.md` in full — same timeouts,
   same page caps, same public-network-only rules, same robots.txt
   compliance), and for any gap where real, better data is actually found,
   calls the existing `POST /internal/supplier-bot/suppliers` refresh path
   (same `candidateId`, so it's the same idempotent update-in-place the
   ingestion pipeline already relies on) with only the improved fields.
3. Per-run cap: at most **10 suppliers** re-crawled and refreshed per run,
   regardless of how many the queue reports — this is on top of, not
   instead of, whatever daily crawl/cost ceilings `docs/AUTONOMY.md` and the
   existing circuit breakers already enforce for discovery. If those
   ceilings are already tight for the day, this routine's re-crawls count
   against them like any other crawl activity — check remaining budget
   before spending it here, and skip the cycle (log why) rather than push
   through a ceiling.
4. Every attempted fix — successful or not — gets one line in this file's
   session log: supplier id/website, which gaps were targeted, what was
   found (or "nothing real found, skipped"), and what was actually written
   back.

Once that capability exists, later runs just use it: pull the queue, work
the cap, log the results. Only touch the audit/fix code itself again if a
real defect in it is blocking real fixes.

## Write policy — read this every run

Two different kinds of change happen here, with different rules:

**Code changes to this repo** (the audit service/script above, or fixing a
real bug found while building or running it): full autonomous merge
authority, same discipline as `docs/devops-assistant-progress.md`:

1. Implement the change.
2. Run the test suite. If red, diagnose and fix the real cause, repeat
   until green.
3. Once green, stop and independently re-review the whole diff as if it
   were a stranger's PR handed to you cold — bugs, edge cases, security
   issues (this code holds and uses `EVENTFLOW_BOT_HMAC_SECRET` — never log
   it, never widen what it's sent to), anything the implementation pass
   would be biased to miss.
4. Fix everything that review turns up, push, re-run tests to green again.
5. Merge the pull request yourself.

**Live supplier-data writes** (the actual re-crawl-and-refresh fixes): not a
PR — these go straight to production data via the existing HMAC-signed
refresh endpoint, the same way the normal publish pipeline already writes
this data. That means the per-run cap above and the "only real data, never
invented" rule are the entire safety net for this path — there is no
review-before-merge step for an individual fix the way there is for code.
Treat picking what counts as "real, better data" conservatively: prefer
skipping a gap over writing something you're not confident is accurate and
current on the supplier's own site right now.

Leave a PR open instead of merging code, or skip a supplier instead of
writing a fix, only when: tests cannot honestly be made green after real
effort; the work needs something this routine cannot do itself (money,
credentials, real external legal sign-off); or a re-crawl finds the
supplier's site has materially changed in a way that suggests the whole
profile (not just a missing photo) may now be wrong — flag that in the
backlog for a human rather than guessing.

## Backlog

- [ ] First run: build the audit-queue service + `audit-unclaimed-quality.ts`
      script per the Mandate above, with real tests (mocked HTTP for the
      EventFlow endpoint calls, same pattern as the existing ingestion
      service's tests). Then run it once against the live queue and log the
      real results.

## Discovered along the way

(Empty — add anything found that isn't today's task, with enough detail for
a future session to act on it without re-discovering it from scratch.)

## Session log

(Empty — each run appends a dated entry: what the audit queue showed, what
was re-crawled, what was actually fixed vs skipped and why, what's still
open.)
