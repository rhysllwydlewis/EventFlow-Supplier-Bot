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
- [x] `packagesMissingPhotos`: gave it a real, conservative deterministic
      matcher (`src/services/package-photo-matcher.ts`,
      `matchPackagePhotos`) instead of the unconditional skip — a recrawled
      photo is only ever attached to a named package when it was found on
      that exact package's own `sourceUrl` AND its alt text names every
      significant word of the package's title. Also added the `image`
      field `ShadowProfile.packages` never had. Merged in
      [#68](https://github.com/rhysllwydlewis/EventFlow-Supplier-Bot/pull/68).
      **Not yet exercised against the live queue** — same credentials gap
      as the rest of this routine, see today's session log.
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

**2026-09-17** — Picked up the `packagesMissingPhotos` backlog item; live
queue still blocked on credentials.

- Read this file, checked `git log`/open PRs on both this repo and
  EventFlow for the last ~24h of manual activity before starting. Found one
  open PR on EventFlow (#1678, "Fix duplicate page-init scripts causing
  double contact-form submission", from the separate dev-ops routine,
  untouched by this change) and none on this repo — nothing mid-iteration
  in this routine's own area.
- Re-checked this environment's credentials: this session actually has
  `EVENTFLOW_INTERNAL_BASE_URL` now (new since the last two entries), but
  still only `EVENTFLOW_OPS_BOT_HMAC_SECRET`, not `EVENTFLOW_BOT_HMAC_SECRET`
  — confirmed against `src/config/env.ts`'s schema. Live re-crawl-and-refresh
  still cannot happen this session for the same reason as every prior entry
  — stood down on that portion again rather than guess against the wrong
  credential.
- Rather than end the run with nothing done over a blocker already known
  and unchanged, picked up the last open extraction-capability gap:
  `packagesMissingPhotos`. Traced how a package photo actually reaches a
  live EventFlow listing (`services/supplierBotMarketplaceParity.service.js`
  in the EventFlow repo) and found the real root cause this gap was never
  fixable before: `ShadowProfile.packages` had no `image` field at all, so
  every package this bot ever sent had `item.image` undefined, and EventFlow
  always fell back to round-robining a package's photo across the
  supplier's generic images rather than a photo of that specific package.
- Added the `image` field to the packages schema, and
  `src/services/package-photo-matcher.ts` (`matchPackagePhotos`): a
  recrawled photo is only attached to a named package when it was found on
  that exact package's own `sourceUrl` AND its alt text names every
  significant word of the package's title — both signals required, per the
  design questions this Backlog entry originally posed. Wired into
  `audit-unclaimed-quality.ts`'s `packagesMissingPhotos` handling.
- Followed the Write policy: implemented, tests green (428/428, 11
  new/changed), typecheck and lint clean, independently re-reviewed the
  whole diff adversarially via a separate agent pass. That review found one
  real bug: the first draft keyed matched photos by package *name* and
  applied them back by name too, so two packages sharing a name (e.g. two
  different "Silver Package" offerings on different pages) would have had
  their photos swapped or collapsed onto a single winner. Fixed by keying
  matches on each package's array position instead, added a regression test
  covering the same-name/different-page case directly, tests green again
  (428/428), merged myself:
  [#68](https://github.com/rhysllwydlewis/EventFlow-Supplier-Bot/pull/68).
- The review's other note (single-significant-word titles like "Silver
  Package"/"Gold Package" are the norm for this domain, not the edge case,
  so page-locality is doing most of the real work once title tokens reduce
  to one word) is a design limitation, not a bug — accepted as a
  documented residual risk in the matcher's own comments, consistent with
  how single-signal alternatives were already rejected elsewhere in this
  file. A future session could strengthen it further (e.g. requiring
  candidate-photo uniqueness on the page, or a higher score floor) if it
  turns out to matter once this runs against real data.
- **Still open for next time**: same live-run credentials gap as every
  prior entry — needs `EVENTFLOW_BOT_HMAC_SECRET` specifically (not
  `EVENTFLOW_OPS_BOT_HMAC_SECRET`, and now that
  `EVENTFLOW_INTERNAL_BASE_URL` is present, the bot secret is the only
  missing piece) in whatever environment picks this up next. All four
  extraction-capability gaps this routine originally opened with are now
  closed (`missingTags`, `missingDescription`/cover/gallery, `missingPhone`,
  `packagesMissingPhotos`) — the only remaining backlog item is running the
  script for real once credentials allow it.

**2026-10-01** — Scheduled, unattended run; live queue still blocked on credentials.

- Checked `git log origin/main` (nothing in the last 24h) and open PRs
  (only #73, the dev-ops routine's safety-ceiling tests + acquisition-slot
  release fix, left open for human review; not in this routine's area).
- Re-checked this environment's credentials: `MONGODB_URI`,
  `EVENTFLOW_INTERNAL_BASE_URL` and `EVENTFLOW_OPS_BOT_HMAC_SECRET` are
  present; `EVENTFLOW_BOT_HMAC_SECRET` (what `src/config/env.ts` requires)
  is still absent. Did not substitute the ops secret — it is a different
  credential for a different integration. Nothing was fetched, re-crawled
  or written; no crawl budget was spent.
- Code backlog is empty; nothing to build speculatively.
- **Still open**: the only remaining backlog item — run
  `npm run audit:unclaimed-quality` once `EVENTFLOW_BOT_HMAC_SECRET` is
  provided to this routine's environment.

**2026-10-02** — Scheduled, unattended run; live queue still blocked on credentials.

- `git log origin/main` shows nothing in the last ~30h; no mid-iteration work in this area.
- Credentials re-checked: `MONGODB_URI`, `EVENTFLOW_INTERNAL_BASE_URL` and
  `EVENTFLOW_OPS_BOT_HMAC_SECRET` present; `EVENTFLOW_BOT_HMAC_SECRET` still
  absent. Did not substitute the ops secret. Nothing fetched, re-crawled or
  written; no crawl budget spent.
- **Still open**: provide `EVENTFLOW_BOT_HMAC_SECRET` to this routine's
  environment, then run `npm run audit:unclaimed-quality`.

**2026-10-03** — Scheduled, unattended run; live queue still blocked on credentials.

- `git log origin/main` shows nothing in the last ~30h; no mid-iteration work in this area.
- Credentials re-checked: `MONGODB_URI`, `EVENTFLOW_INTERNAL_BASE_URL` and
  `EVENTFLOW_OPS_BOT_HMAC_SECRET` present; `EVENTFLOW_BOT_HMAC_SECRET` still
  absent (4th consecutive run). Did not substitute the ops secret. Nothing
  fetched, re-crawled or written; no crawl budget spent.
- **Still open**: provide `EVENTFLOW_BOT_HMAC_SECRET` to this routine's
  environment, then run `npm run audit:unclaimed-quality`.

**2026-10-04** — Scheduled, unattended run; live queue still blocked on credentials.

- `git log --all` shows only a dev-ops handoff update (2026-10-03 09:05) in the last ~30h; nothing mid-iteration in this area.
- Credentials re-checked: `MONGODB_URI`, `EVENTFLOW_INTERNAL_BASE_URL` and
  `EVENTFLOW_OPS_BOT_HMAC_SECRET` present; `EVENTFLOW_BOT_HMAC_SECRET` still
  absent (5th consecutive run). Did not substitute the ops secret. Nothing
  fetched, re-crawled or written; no crawl budget spent.
- **Still open**: provide `EVENTFLOW_BOT_HMAC_SECRET` to this routine's
  environment, then run `npm run audit:unclaimed-quality`.

**2026-10-05** — Scheduled, unattended run; live queue still blocked on credentials.

- `git log --all` shows only a dev-ops handoff update (2026-10-04 09:05) in the last ~30h; nothing mid-iteration in this area.
- Credentials re-checked: `MONGODB_URI`, `EVENTFLOW_INTERNAL_BASE_URL` and
  `EVENTFLOW_OPS_BOT_HMAC_SECRET` present; `EVENTFLOW_BOT_HMAC_SECRET` still
  absent (6th consecutive run). Did not substitute the ops secret. Nothing
  fetched, re-crawled or written; no crawl budget spent.
- **Still open**: provide `EVENTFLOW_BOT_HMAC_SECRET` to this routine's
  environment, then run `npm run audit:unclaimed-quality`.

**2026-10-06** — Scheduled, unattended run; live queue still blocked on credentials.

- `git log --all` shows only dev-ops activity (PR #73 merged 2026-10-05, handoff update) in the last ~30h; nothing mid-iteration in this area.
- Credentials re-checked: `MONGODB_URI`, `EVENTFLOW_INTERNAL_BASE_URL` and
  `EVENTFLOW_OPS_BOT_HMAC_SECRET` present; `EVENTFLOW_BOT_HMAC_SECRET` still
  absent (7th consecutive run). Did not substitute the ops secret. Nothing
  fetched, re-crawled or written; no crawl budget spent.
- **Still open**: provide `EVENTFLOW_BOT_HMAC_SECRET` to this routine's
  environment, then run `npm run audit:unclaimed-quality`.

**2026-10-07** — Scheduled, unattended run; live queue still blocked on credentials.

- `git log --all` shows only dev-ops activity (PR #85 merged 2026-10-06, handoff update) in the last ~30h; nothing mid-iteration in this area.
- Credentials re-checked: `MONGODB_URI`, `EVENTFLOW_INTERNAL_BASE_URL` and
  `EVENTFLOW_OPS_BOT_HMAC_SECRET` present; `EVENTFLOW_BOT_HMAC_SECRET` still
  absent (8th consecutive run). Did not substitute the ops secret. Nothing
  fetched, re-crawled or written; no crawl budget spent.
- **Still open**: provide `EVENTFLOW_BOT_HMAC_SECRET` to this routine's
  environment, then run `npm run audit:unclaimed-quality`.

**2026-10-08** — Scheduled, unattended run; live queue still blocked on credentials.

- `git log --all` shows only dev-ops activity (PR #86 merged, handoff update) in the last ~30h; no open PRs; nothing mid-iteration in this area.
- Credentials re-checked: `MONGODB_URI`, `EVENTFLOW_INTERNAL_BASE_URL` and
  `EVENTFLOW_OPS_BOT_HMAC_SECRET` present; `EVENTFLOW_BOT_HMAC_SECRET` still
  absent (9th consecutive run). Did not substitute the ops secret. Nothing
  fetched, re-crawled or written; no crawl budget spent.
- **Still open**: provide `EVENTFLOW_BOT_HMAC_SECRET` to this routine's
  environment, then run `npm run audit:unclaimed-quality`.

**2026-10-09** — Scheduled, unattended run; live queue still blocked on credentials.

- `git log --all` shows only dev-ops activity (handoff update 2026-10-08 09:06) in the last ~30h; nothing mid-iteration in this area.
- Credentials re-checked: `MONGODB_URI`, `EVENTFLOW_INTERNAL_BASE_URL` and
  `EVENTFLOW_OPS_BOT_HMAC_SECRET` present; `EVENTFLOW_BOT_HMAC_SECRET` still
  absent (10th consecutive run). Did not substitute the ops secret. Nothing
  fetched, re-crawled or written; no crawl budget spent.
- **Still open**: provide `EVENTFLOW_BOT_HMAC_SECRET` to this routine's
  environment, then run `npm run audit:unclaimed-quality`.

**2026-10-10** — Scheduled, unattended run; live queue still blocked on credentials.

- `git log --all` shows only the prior routine's own log entry and a dev-ops handoff update (2026-10-09) in the last ~30h; no open PRs; nothing mid-iteration in this area.
- Credentials re-checked: `MONGODB_URI`, `EVENTFLOW_INTERNAL_BASE_URL` and
  `EVENTFLOW_OPS_BOT_HMAC_SECRET` present; `EVENTFLOW_BOT_HMAC_SECRET` still
  absent (11th consecutive run). Did not substitute the ops secret. Nothing
  fetched, re-crawled or written; no crawl budget spent.
- **Still open**: provide `EVENTFLOW_BOT_HMAC_SECRET` to this routine's
  environment, then run `npm run audit:unclaimed-quality`.

**2026-10-10 (second run, scheduled, unattended)** — Credential gap partly closed; live run still not possible.

- `git log --all` shows only this routine's own earlier entry and a dev-ops handoff update; no open PRs; nothing mid-iteration in this area.
- **New:** `EVENTFLOW_BOT_HMAC_SECRET` is now present in the environment (first time in 12 runs), alongside `EVENTFLOW_INTERNAL_BASE_URL`, `EVENTFLOW_OPS_BOT_HMAC_SECRET` and `MONGODB_URI`.
- Built `dist/` and ran `npm run audit:unclaimed-quality`. It exits immediately at env validation: `REDIS_URL`, `CONTROL_ADMIN_KEY` and `CONTROL_SESSION_SECRET` are required by `src/config/env.ts` and are not set here. None are used by the audit path itself, but I did not invent placeholder values to get past validation.
- `MONGODB_URI` points at a Railway proxy host (`hayabusa.proxy.rlwy.net`) with no database name in the path. The script reads bot settings and writes crawl-budget counters and shadow profiles to it. A read-only listing of databases/collections to confirm it is the bot's own database was denied by the permission classifier, and I did not work around that. Same unresolved question as the 2026-09-16 entry.
- Nothing fetched from the audit queue, nothing re-crawled, nothing written; no crawl budget spent.
- **Still open:** provide `REDIS_URL`, `CONTROL_ADMIN_KEY` and `CONTROL_SESSION_SECRET` (or make `env.ts` not require them for scripts — a reasonable small code fix for a future session), and confirm `MONGODB_URI` targets the bot's database. Then run `npm run audit:unclaimed-quality`.

**2026-10-10 (third run, scheduled, unattended)** — All env vars present; live run blocked on MongoDB reachability.

- `git log --all` shows only this routine's own entries and dev-ops handoff updates; no open PRs; nothing mid-iteration in this area.
- **New:** `EVENTFLOW_BOT_HMAC_SECRET`, `REDIS_URL`, `CONTROL_ADMIN_KEY`, `CONTROL_SESSION_SECRET`, `EVENTFLOW_INTERNAL_BASE_URL` and `MONGODB_URI` are all set now; env validation passes.
- Built `dist/` and ran `npm run audit:unclaimed-quality`: it fails in `getSettings()` with `MongoServerSelectionError: Server selection timed out after 10000 ms` — this sandbox cannot reach the `MONGODB_URI` host (Railway TCP proxy; the sandbox only has an HTTPS agent proxy). The run gate reads bot settings from Mongo first, so nothing was fetched from the audit queue, re-crawled or written; no crawl budget spent.
- **Still open:** either run this routine in an environment with raw TCP egress to the bot's MongoDB, or (code change) let the audit script obtain settings/budget state without a direct Mongo connection. The 2026-09-16 question of whether `MONGODB_URI` targets the bot's own DB (`BOT_DB_NAME` defaults to `eventflow_supplier_bot`) also remains unconfirmed.

**2026-10-10 (setup, owner-approved)** — Moved the live audit run into Railway.

- Created Railway service `supplier-bot-quality-audit` (EventFlow project, production env, service id `5a7d28b7-e805-442b-bea1-7452f80db854`), source `EventFlow-Supplier-Bot` `main` (Dockerfile build), start command `npm run audit:unclaimed-quality`, cron `0 14 * * *` (14:00 UTC daily), restart policy NEVER. Env vars are `${{supplier-bot-worker.NAME}}` references (Mongo/Redis/control creds, EventFlow URL + `EVENTFLOW_BOT_HMAC_SECRET`, `ABSOLUTE_MAX_*`, `BROWSER_*`, namespace/log/ingestion flags); `EVENTFLOW_OPS_BOT_HMAC_SECRET` deliberately not passed.
- First build (deployment `3eef4c76-...`) was in progress at 10:33 UTC and building normally. Not yet verified deployed or run.
- **Next run:** read this service's deploy logs via Railway (`get-logs`/`list-deployments`) instead of trying to run the script from the sandbox (it cannot reach Mongo). Record what the queue showed, what was fixed vs skipped, and notify the owner if the cron failed or never ran. Fix real defects in the script via PR.

**2026-10-10 (first live run, Railway cron service)** — Ran for real, ~3 min, exit OK.

- Cron service `supplier-bot-quality-audit` fired (deployment `2e47ca5c-...`), connected to Mongo db `eventflow_supplier_bot` (confirms `MONGODB_URI` targets the bot's own DB). Schedule left at `0 14 * * *` (was temporarily set to 10:42 UTC to trigger this run, then restored).
- Queue: 171 published unclaimed profiles, 28 needing work; capped to 10 audited.
- Result: **0 fixed, 0 written to EventFlow.** Of the 10 audited, 9 targeted `missingPhone` and ended `no_real_fix_found` (`no_phone_number_found_on_recrawl` — the sites' own pages show no phone number the extractor accepts; includes directory-style URLs such as designmynight.com, poptop.uk.com, wedding-caterers.co.uk, hafodfarm.co.uk/supplier-directory). 1 (hensolcastle.com, `missingTags`) was skipped: `no_local_shadow_profile_for_candidate`.
- Observations for next session: (1) several queue entries are directory/listing pages rather than a supplier's own site, so a recrawl cannot find a phone — worth checking whether those profiles should be in the queue/published at all (flag for a human; do not unpublish from here). (2) `no_local_shadow_profile_for_candidate` means the bot DB has no shadow profile for that candidate; the refresh path cannot build a patch without one. (3) Railway stdout lines are shuffled in `get-logs`; read supplier ids/outcomes by grouping, or add a single-line JSON summary to the script.
- **Still open:** next 14:00 UTC run will take the next worst-first 10; check Railway logs for it.

**2026-10-10 (follow-up, owner-approved)** — Directory-page finding + run-summary PR.

- Merged [#87](https://github.com/rhysllwydlewis/EventFlow-Supplier-Bot/pull/87): the script now also logs one structured `Unclaimed quality audit: run summary` entry (counts, per-supplier outcome/fixed/reasons) so Railway logs are readable.
- Pulled the full queue (read-only, 28 needing work, 27 of them `missingPhone`). **About half are not a supplier's own site** — third-party directories/guides/aggregators/news, which is why no phone is ever found: designmynight.com, poptop.uk.com, wedding-caterers.co.uk, event-caterers.co.uk, event-catering.uk, ukweddingservices.com, hirespace.com, wedissimo.com, encoremusicians.com (hire/entertainers page), hafodfarm.co.uk/supplier-directory, ewegottalove.com/venues-in-wales, guides.ticketmaster.co.uk, southwalesguardian.co.uk/leisure, celticenglish.co.uk (places-to-visit listing); cassowary.cafe is "catering-swansea-**nsw**" (Australia). **Flagged for a human**: decide whether to unpublish these and whether discovery should reject directory/aggregator domains (separate PR in the discovery code; not done here). This routine does not unpublish.
- Real supplier sites with a genuinely missing phone (e.g. photographers' own sites) still ended `no_real_fix_found` — their pages may show no phone at all; nothing to write.
