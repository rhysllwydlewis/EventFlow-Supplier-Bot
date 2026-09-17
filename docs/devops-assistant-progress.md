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

## Discovered along the way

- Zero behavioral test coverage for five daily safety-ceiling claim
  functions: `acquisition-budget.service.ts`, `crawl-budget.service.ts`,
  `browser-crawl-budget.service.ts`, `ai-circuit.service.ts`,
  `ai-usage.service.ts`. All five implement the same atomic
  `findOneAndUpdate`-with-`$lt`/`$inc` "claim under a daily ceiling"
  pattern as `ai-budget.service.ts` (which enforces
  `ABSOLUTE_MAX_AI_SPEND_GBP_PER_DAY` and *does* have thorough behavioral
  tests in `tests/ai-budget.test.ts`, using a fake in-memory Mongo
  collection). The other five only get indirect, source-string-matching
  assertions in a couple of other test files — nothing exercises their
  claim/release atomicity directly. Risk: a future refactor of the shared
  pattern could silently break the atomicity guarantee that stops
  concurrent discovery/crawl cycles from jointly exceeding a daily hard
  cap, and the existing suite wouldn't catch it. Flagging rather than
  fixing directly since this is safety-ceiling code (this routine's merge
  policy asks for human eyes before touching anything in that category,
  and porting the `ai-budget.test.ts` fake-Mongo pattern to five more
  files is a bigger, more deliberate chunk than a "just add tests"
  drive-by). Recommend a session picks this up as its whole cycle: port
  the same fake-collection test pattern to all five, one PR, human-
  reviewed before merge.
- Minor, not worth its own PR: `src/crawler/safe-fetch.ts` around line
  145-147 derives `contentType` via `.split(';')[0]`, so it can never
  contain a `;` — the subsequent
  `contentType.startsWith(\`${type};\`)` branch is therefore dead code
  (unreachable). Not an active bug (the equality check on the same line
  already covers every case it was presumably meant to catch), just a
  correctness smell worth folding into whatever PR next legitimately
  touches that function.

## Session log

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
