# EventFlow-Supplier-Bot Dev-Ops Assistant — handoff

Running handoff file for the automated dev-ops routine on this repo: mandate,
merge policy, backlog, a "discovered along the way" list, and a dated session
log. Trust this file over your own assumptions — correct any entry you find
wrong rather than leaving it for a cold session to chase it.

## Important: this repo is not idle — you are not alone here

Unlike the other repos this owner automates, **this one has active manual
Claude Code sessions working on it too** (a different account, used for
hands-on work). 62 PRs have merged here, the most recent the day this routine
was set up. This is a live, actively-developed system, not an abandoned one
you're filling a gap in.

Before picking any work:
- Check `git log --oneline -20` and open PRs for activity in roughly the last
  24 hours. If an area looks like it's mid-iteration (recent commits, an open
  PR touching it, a very fresh branch), leave it alone this cycle — don't
  duplicate or collide with live manual work.
- Check for any other `claude/*` or working branches beyond your own and
  treat them the same way: read, don't touch, unless clearly stale/abandoned.
- When genuinely unsure whether something is active, prefer a different,
  clearly-idle area over guessing.

## Mandate

Also unlike the other repos, **treat the top-level `docs/` planning files
(`NEXT_SLICE.md`, `IMPLEMENTATION_PROGRESS.md`) as possibly stale** — they
read like early Phase 0/1 status, but `docs/PHASE3_*.md` files exist and
recent PR history (crawl remediation, compliance scoring, media audits) shows
real Phase 3 work already happened. Ground what "current state" actually
means in `git log`, open/closed PRs, and the actual code — not in a planning
doc that may not have been updated.

Within that, general dev-ops scope: bugs, broken flows, missing tests, poor
error handling, code quality — the same kind of sweep as this owner's other
repos. Respect the project's existing safety posture: it operates in Shadow
mode with hard daily caps and explicit `docs/AUTONOMY.md` / `docs/SHADOW_MODE.md`
/ `docs/CRAWLER_POLICY.md` constraints — read these before touching discovery,
crawling, extraction, or publication code, and never loosen a safety/compliance
check to make something pass.

## Merge policy — read this every run

Full autonomous merge authority, same discipline as this owner's other repos:

1. Implement the change.
2. Run the test suite. If red, diagnose and fix the real cause, repeat until
   green.
3. Once green, stop and independently re-review the whole diff as if it were
   a stranger's PR handed to you cold — bugs, edge cases, security issues,
   anything the implementation pass would be biased to miss.
4. Fix everything that review turns up and push the update.
5. Re-run tests — green again after the review fixes, not just after step 2.
6. Merge the pull request yourself.

Leave a PR open instead of merging only when: tests cannot honestly be made
green after real effort; the work needs something you cannot do yourself
(money, credentials, external legal sign-off); or the change touches
discovery/crawling/publication safety limits (daily caps, Shadow-mode gates,
compliance/quality thresholds) — those get a human's eyes first given the
whole point of Shadow-first design is caution before real supplier contact.

## Backlog

- [x] General sweep: verify actual current phase/state against real code and
      recent PRs (not the possibly-stale planning docs), then find genuine
      bugs, gaps, or quality issues — verify each is real before fixing.
      Done 2026-09-17: fixed the dead provider_usage ledger (PR #70, see
      session log). Re-open this as a recurring item each cycle nothing
      more specific is pending — there's always another sweep to do.
- [x] Port the `ai-budget.test.ts` fake-Mongo test pattern to the other five
      safety-ceiling/usage services (see "Discovered along the way" below).
      Done 2026-09-18: PR #73, see session log. **Left open, not merged** —
      it includes a production logic fix to safety-ceiling code
      (acquisition-slot release), which this routine's merge policy routes
      to human review. Check PR #73's state first if picking this up.

## Discovered along the way

- Minor, not worth its own PR: `src/crawler/safe-fetch.ts` around line
  145-147 derives `contentType` via `.split(';')[0]`, so it can never
  contain a `;` — the subsequent
  `contentType.startsWith(\`${type};\`)` branch is therefore dead code
  (unreachable). Not an active bug (the equality check on the same line
  already covers every case it was presumably meant to catch), just a
  correctness smell worth folding into whatever PR next legitimately
  touches that function. Still present as of 2026-09-23.
- `src/services/package-photo-matcher.ts`'s `matchPackagePhotos` (lines
  55-85) never uses `PackagePhotoMatchTarget.id` (the specific package
  instance EventFlow's audit flagged as missing a photo) — it only matches
  by `title`/`name`. The code's own comments (here and in
  `audit-unclaimed-quality.ts`) acknowledge two packages can legitimately
  share a name, but nothing disambiguates them by id, and there's no check
  that the target package's `image` is actually null before overwriting
  it. Call path: `audit-unclaimed-quality.ts:162-176` applies any match
  straight into a wholesale-replace patch pushed to EventFlow
  (`eventflow-quality-audit.service.ts`'s `refreshEventFlowSupplierData`)
  with no human in the loop. Plausible real bug (could overwrite an
  already-correct package photo on a live listing) but medium confidence
  and non-trivial to fix properly (would need a stable per-package id
  threaded through, or at least an "only touch packages with a null image"
  guard) — flagging for a future session to pick up as its own chunk rather
  than a drive-by fix.

## Session log

### 2026-09-23

Branch's last PR (#73) is still open (not merged, not stale — see below),
so did NOT restart the branch from main. `add_repo`/`register_repo_root`
still don't exist in this environment; repo was already checked out, git
access worked fine via the proxy as in every prior session.

Checked PR #73 first, as the previous entry asked: CI still green
(`verify` + GitGuardian both success on head `bad0dfe`), `mergeable_state`
clean, zero human reviews submitted (only two bot comments: a Codex
quota-exceeded notice and a Railway preview-env no-op, neither actionable).
Still exactly as described in the 2026-09-18 entry — genuinely waiting on
a human, not something this routine can push further on. Left it alone.

Checked for collisions: `git log --oneline` across every branch showed
**nothing newer than 2026-09-18** (this branch's own last commit) — no
manual-session activity in the last ~5 days on any branch. Field was
completely clear.

No red CI, no unresolved review comments, and both backlog items are
already checked off (recurring general-sweep item is always "reopened" by
design), so went to the general sweep. Delegated a read-only bug-hunt
across crawler/extraction/evidence/providers/queues/repositories/services/
worker/control/domain to a subagent, with AUTONOMY.md/SHADOW_MODE.md/
CRAWLER_POLICY.md read first, and excluding every file PR #73 already
touches. It came back with 2 candidates; verified the top one myself
against real call sites before acting (the second is the package-photo-
matcher item added to "Discovered along the way" above, not fixed this
cycle — medium confidence, deserves its own dedicated pass).

**Fixed the verified bug**: `applyIdentityDedupGate` in
`src/services/dedup-compliance.service.ts` unconditionally defaulted
`status` to `'review'` unless the dedup decision was `strong_duplicate` —
so a candidate already `'block'`ed by the underlying content-compliance
assessment (missing media, wrong category, etc.) would get silently
*downgraded* to `'review'` the moment a `probable_duplicate` or still-
pending dedup check ran on it, hiding the real, more severe block reason
from both real consumers: the Control UI's `/api/shadow-profiles-pending`
and `eventflow-one-profile-pilot.service.ts`'s failure `reason` string.
Verified both call sites (transitively via
`getComplianceAssessmentsForCandidates`). Not a safety-gate weakening:
`publicationEligible`/`seoIndexEligible` still always end up `false` for
every non-`distinct` decision, and `strong_duplicate` still always forces
`'block'` — this only stops an already-`'block'` status being overwritten
with something less severe. Added 3 tests pinning down the previously-
untested "already blocked" path; confirmed they fail against the pre-fix
logic and pass with it restored. `npm run check`: 458 tests, lint/
typecheck/build all green.

Per merge policy step 3, sent the diff to a subagent for an independent
adversarial re-review — it worked through all 12 (decision × base-status)
combinations, confirmed the new tests aren't vacuous (temporarily reverted
the fix, watched exactly the 2 new downgrade tests fail, restored it), and
re-verified both call sites. Came back clean (PASS), only minor,
non-blocking notes on test naming/redundancy.

**Opened this as its own PR (#76) on a fresh branch
(`claude/supplier-bot-devops-dedup-status`) cut from `main`, deliberately
NOT stacked on `claude/supplier-bot-devops`.** Reasoning: this branch
already has PR #73 open and explicitly parked for human review (it touches
safety-ceiling logic); pushing more commits here would have folded this
unrelated, otherwise-cleanly-mergeable fix into that same review unit and
delayed it for no reason. `dedup-compliance.service.ts` and its test file
were byte-identical between `main` and this branch's PR #73 head, so the
fix applied cleanly from either base. **Merged PR #76 myself** (green CI,
clean merge state, no safety-ceiling code touched, adversarial review
passed) — see PR for final CI confirmation if picking this up mid-flight.

This handoff-doc update itself is being pushed to `claude/supplier-bot-
devops` per the routine's branch instructions, so it will ride along as an
extra doc-only commit on PR #73 — expected, not a mistake, if a reviewer
notices it there.

If a future session picks this up: check PR #73's state first (same as
every prior entry has said), and note `claude/supplier-bot-devops-dedup-
status` was a one-off branch for a single self-contained fix, not a
new standing convention — go back to restarting `claude/supplier-bot-devops`
itself once PR #73 finally resolves.

Nothing else was pending after this one item, so the cycle ends here today.

### 2026-09-18

Branch's last PR (#70) had merged, so restarted `claude/supplier-bot-devops`
from latest `main` per the routine's own instructions. `add_repo`/
`register_repo_root` still don't exist in this environment; repo was
already checked out (same as 2026-09-17), git access worked fine.

Checked for collisions: no open PRs on the repo at all. Checked every
`claude/*` and other working branch's last-commit timestamp —
`claude/supplier-bot-unclaimed-quality`'s last commit was ~27h old (its
PR #68 already merged on 2026-09-17), everything else was older still.
Nothing looked mid-iteration, field was clear.

No open PRs, no unresolved review comments, so went to the backlog's next
item: last cycle's "Discovered along the way" note recommended a session
pick up, as its whole cycle, porting `tests/ai-budget.test.ts`'s
fake-Mongo-collection pattern to the five other daily safety-ceiling/usage
services that had zero direct behavioral tests (`acquisition-budget`,
`crawl-budget`, `browser-crawl-budget`, `ai-circuit`, `ai-usage`). Did
that: added `tests/{acquisition-budget,crawl-budget,browser-crawl-budget,
ai-circuit,ai-usage}.test.ts`.

Per merge policy step 3, sent the diff to a subagent for an independent
adversarial re-review before considering it done — instructed to actually
mutate each service's core guarantee and confirm the corresponding test
catches it (not just read the diff), then revert. It came back clean on
four of the five, but found a **real bug**: `acquisition-budget.service.ts`'s
`releaseDailyAcquisitionSlot` did a bare unclamped `$inc: -1`, so a double
release (retried call, or any caller bug) pushes a counter negative and
bypasses the acquisition daily cap — verified live (claim 1/1,
double-release, 2 more claims then succeed instead of 1). Also flagged
`acquisition-budget.test.ts` was missing the cross-day release test
`ai-budget.test.ts` has for the identical risk.

Fixed the release path (floor each counter at zero via the same
`findOneAndUpdate`-gated pattern the claim side uses, decremented
independently per counter) and added both missing tests, confirming the
new double-release test actually fails against the pre-fix source before
restoring the fix. `npm run check`: 455 tests (up from 453), lint/
typecheck/build all green throughout.

**Opened PR #73, left it open rather than merging.** The four pure-test
files would ordinarily be auto-mergeable (no production logic touched),
but they're bundled with the acquisition-budget release fix, which *does*
touch safety-ceiling enforcement logic (the acquisition cap) — per this
routine's own merge policy, that category gets a human's eyes first. If a
future session picks this up, check PR #73's state before doing anything
else with `acquisition-budget.service.ts` or its tests.

Nothing else was pending after this one item, so the cycle ends here today.

### 2026-09-17

Repo already checked out locally; no `add_repo`/`register_repo_root` tools
exist in this environment (not a failure — git access here is
proxy-configured instead, confirmed the checkout and remote worked fine).

Checked for collisions first: `claude/supplier-bot-unclaimed-quality` (a
different automated routine — "Unclaimed Profile Quality Assistant") had
commits as recent as ~1 hour before this run, and PR #68 touching
`src/scripts/audit-unclaimed-quality.ts`, `src/services/package-photo-matcher.ts`,
`src/domain/shadow-profile.ts` (packages/image field) and the photo-matching
parts of `src/services/ai-enrichment.service.ts` had merged to main only
~2 hours before this run started. Stayed away from all of it and from
`docs/unclaimed-quality-progress.md`'s whole scope this cycle — clearly
live, not mine to touch.

No open PRs and no unresolved review comments on this branch to work
first. Backlog only had the generic "general sweep" item, so did that:
delegated a broad bug-hunt across crawler/extraction/evidence/providers/
queues/repositories/services/worker/control/config/domain (excluding the
areas above) to a subagent, with AUTONOMY.md/SHADOW_MODE.md/
CRAWLER_POLICY.md read first and instructed to flag rather than fix
anything touching safety ceilings. It came back with 3 candidates; verified
the top one myself against the actual call sites before acting (the other
two are in "Discovered along the way" above, not fixed this cycle).

**Fixed and opened PR #70**: `recordProviderUsage`/`getTodayProviderUsage`
in `src/services/provider-usage.service.ts` were fully implemented but
never called from anywhere — `resultsSeen` was computed every discovery
cycle but only ever lived in-memory on that cycle's audit event, no running
daily total anywhere. Wired `recordProviderUsage` into `runDiscoveryCycle`
after each `provider.search()`, surfaced the daily totals plus the
previously-unsurfaced `providerSearchesPerDay` safety-ceiling value on
`/api/status`. Deliberately left `estimatedCostGbp` at its zero default —
no provider adapter here has a configured per-search price, and I'm not
inventing one. Added real behavioral test coverage (fake-Mongo pattern,
not just source-string assertions) plus a wiring test. `npm run check`
green locally (369 tests, was 365). This is read-only instrumentation, does
not touch any safety-limit enforcement logic itself, so didn't route it to
human review.

PR #70 pushed and opened; CI was still pending as of this entry (see PR for
current status). Per this routine's merge policy, will merge myself once
CI confirms green and no new review feedback needs addressing — if a
future session picks this up instead, check PR #70's state first.

Nothing else was pending after this one item, so the cycle ends here today.
