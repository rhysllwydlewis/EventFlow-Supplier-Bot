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

- [x] First run: build the audit-queue service + `audit-unclaimed-quality.ts`
      script per the Mandate above, with real tests (mocked HTTP for the
      EventFlow endpoint calls, same pattern as the existing ingestion
      service's tests). Merged in
      [#64](https://github.com/rhysllwydlewis/EventFlow-Supplier-Bot/pull/64).
      **Not yet run against the live queue** — see 2026-09-16's session log
      entry for why, and pick this up first next session.
- [x] `missingTags`/`missingDescription`-adjacent: give the crawler/extraction
      pipeline a real, deterministic way to extract a services/tags list.
      Done via JSON-LD `serviceType`/`makesOffer` only (a page's `<meta
      name="keywords">` was tried and deliberately dropped again — see
      "Discovered along the way" below) in
      [#65](https://github.com/rhysllwydlewis/EventFlow-Supplier-Bot/pull/65).
      `audit-unclaimed-quality.ts` no longer unconditionally skips
      `missingTags`. **Not yet exercised against the live queue** — same
      credentials gap as the rest of this routine, see today's session log.
- [ ] `packagesMissingPhotos`: the audit-queue reports specific packages with
      a placeholder image, but there is no reliable way yet to match one of
      a recrawl's generic extracted photos to one specific named package
      (title text match against alt/nearby text? page-section proximity?).
      Needs real design, not a guess — `audit-unclaimed-quality.ts`
      unconditionally skips this gap today, logged as
      `no_reliable_photo_to_package_matching_yet`.
- [ ] Run `npm run audit:unclaimed-quality` for real once the deployed
      environment's credentials are available in whatever session picks this
      up, and log the actual results here.

## Discovered along the way

- EventFlow's `POST /internal/supplier-bot/suppliers/audit-queue` endpoint
  (`routes/supplier-profile-safe.js` in the EventFlow repo) already existed
  before this session started work — merged there as PR #1672, ahead of this
  repo's own client/script. Worth checking the EventFlow-repo-side handoff
  doc (if one exists there) for whether that was itself built by an earlier,
  cold run of a similarly-named routine, since this file's own backlog still
  read "First run: build..." for both halves.
- This dev/build session's container only had `MONGODB_URI` and an
  `EVENTFLOW_OPS_BOT_HMAC_SECRET` (a differently-named credential, almost
  certainly for a separate ops/devops integration, not this bot's own
  `EVENTFLOW_BOT_HMAC_SECRET`) available in its environment — no
  `EVENTFLOW_INTERNAL_BASE_URL` and no `EVENTFLOW_BOT_HMAC_SECRET`. That
  meant a live run genuinely could not happen this session (see Mandate:
  "the work needs something this routine cannot do itself... credentials"
  is an explicit, listed reason to skip). Whatever session next has real
  access to the deployed environment's secrets should run the script for the
  actual first time and replace this note with a real result.
- A page's `<meta name="keywords">` looked like a reasonable second
  deterministic source for `missingTags` (the Backlog entry named it as an
  option) but was cut after an independent adversarial review of the first
  draft: unlike JSON-LD's `serviceType`/`makesOffer` (read from the one
  business object `extractStructuredBusinessFacts` already matches by
  `@type`/`name`), meta keywords are free text pooled from *every* crawled
  page with no tie to the actual business entity — a real vector for stale
  or SEO-stuffed terms that aren't necessarily what the business currently
  offers, on a write path with no human review before it reaches a live
  listing. If a future session wants to bring it back, it needs a real way
  to vet the terms (e.g. cross-referencing against the page's own visible
  text) rather than trusting the tag wholesale.
- `audit-unclaimed-quality.ts`'s run gate deliberately mirrors
  `eventflow-publication.service.ts`'s `publicationControlBlockReason`
  exactly (`runState === 'running'` and `mode === 'live'`, not just "not
  emergency_stopped") rather than the looser check this PR's first draft
  used — an adversarial re-review caught that the looser gate would have let
  a paused bot, or one still in shadow mode, still push real writes to
  production EventFlow. Keep this in mind if a future change to this
  script's gating is proposed: match the *strictest* existing live-write
  gate in this codebase, not just "not explicitly stopped".

## Session log

**2026-09-16** — First run of this routine (scheduled, unattended).

- Read this file, checked `git log`/open PRs on both this repo and
  EventFlow for the last ~24h of manual activity (none touching this area)
  before starting.
- Found EventFlow's `audit-queue` endpoint already live on EventFlow `main`
  (PR #1672) — this repo's own client/script did not exist yet, so this was
  genuinely the "first run: build the capability" case the Mandate
  describes.
- Built `src/services/eventflow-quality-audit.service.ts`
  (`fetchAuditQueue`/`refreshEventFlowSupplierData`) and
  `src/scripts/audit-unclaimed-quality.ts`, with full test coverage,
  following the Write policy: implemented, tests green (406/406, 41 new),
  independently re-reviewed the whole diff adversarially via a separate
  agent pass, fixed everything that review found (the run-gate looseness,
  stale media-evidence provenance when patching an image field, a missing
  phone-length guard already applied on the same field elsewhere), tests
  green again, merged myself:
  [#64](https://github.com/rhysllwydlewis/EventFlow-Supplier-Bot/pull/64).
- The script deliberately skips `missingTags` and `packagesMissingPhotos`
  unconditionally this iteration — no reliable deterministic extraction
  path exists for either yet (see Backlog/"Discovered along the way"). It
  handles `missingCoverImage`, `missingGalleryImages`, `missingDescription`
  and `missingPhone` for real, only writing back when the recrawl finds
  something genuinely better than what's already there.
- **Could not run it against the live queue this session**: this
  container's environment has no `EVENTFLOW_INTERNAL_BASE_URL` or
  `EVENTFLOW_BOT_HMAC_SECRET` configured (see "Discovered along the way"),
  so there was no way to reach the real EventFlow instance or safely
  confirm which database `MONGODB_URI` here actually points to before
  writing bot-settings/crawl-budget counters to it. Per the Mandate's own
  listed exception ("the work needs something this routine cannot do
  itself... credentials"), stood down on the live-run portion rather than
  guess. Nothing was re-crawled, nothing was written to any supplier
  record, real or otherwise.
- **Still open for next time**: run `npm run audit:unclaimed-quality` for
  real in an environment with the actual production credentials, and log
  what the queue showed / what got fixed vs skipped and why. The two
  extraction-capability gaps above (tags/services, package-photo matching)
  are also still open and not this session's to solve speculatively.

**2026-09-16 (later run, scheduled, unattended)** — Picked up the
`missingTags` backlog item; live queue still blocked on credentials.

- Read this file, checked `git log`/open PRs on both this repo and
  EventFlow for the last ~24h of manual activity (none touching this area,
  and no open PRs on either repo) before starting.
- Re-checked this environment's credentials in case anything had changed
  since the last entry above: still `MONGODB_URI` and
  `EVENTFLOW_OPS_BOT_HMAC_SECRET` only, no `EVENTFLOW_INTERNAL_BASE_URL`
  wired to the right secret and no `EVENTFLOW_BOT_HMAC_SECRET` — confirmed
  by reading both this repo's `src/config/env.ts` (expects
  `EVENTFLOW_BOT_HMAC_SECRET`) and EventFlow's
  `middleware/supplierBotHmac.js` (reads that same name; `opsBotHmac.js` is
  the separate ops-assistant credential this environment actually has).
  Live re-crawl-and-refresh still cannot happen this session for the same
  reason as before — stood down on that portion again rather than guess.
- Rather than end the run with nothing done over a blocker already known
  and unchanged, picked up the next Backlog item that doesn't need live
  credentials: gave `missingTags` a real, deterministic fix path instead of
  its unconditional skip, per the open Backlog entry.
- Added `extractServiceTagsFromJsonLd` (`src/extraction/structured-data.ts`)
  and a `serviceTags` field on `BasicExtraction`
  (`src/extraction/basic-extractor.ts`), wired into
  `audit-unclaimed-quality.ts`'s `missingTags` handling. Followed the Write
  policy: implemented, tests green (417/417, 11 new/changed), independently
  re-reviewed the whole diff adversarially via a separate agent pass, which
  found two real risks in the first draft (mid-word truncation of an
  overlong JSON-LD value being written to a live listing; `<meta
  name="keywords">` as an unvetted, entity-unattributed fallback source —
  see "Discovered along the way"). Fixed both (drop overlong candidates
  instead of truncating; dropped meta-keywords as a source entirely), added
  more edge-case coverage (`makesOffer` as a single object, `@graph`-wrapped
  JSON-LD), tests green again, merged myself:
  [#65](https://github.com/rhysllwydlewis/EventFlow-Supplier-Bot/pull/65).
- `packagesMissingPhotos` is untouched — still needs real design, not a
  guess, per the Backlog.
- **Still open for next time**: same live-run credentials gap as every
  prior entry — needs `EVENTFLOW_BOT_HMAC_SECRET` (not
  `EVENTFLOW_OPS_BOT_HMAC_SECRET`) in whatever environment picks this up
  next. `packagesMissingPhotos` still needs real design work.
