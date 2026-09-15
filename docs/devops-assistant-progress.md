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

- [ ] General sweep: verify actual current phase/state against real code and
      recent PRs (not the possibly-stale planning docs), then find genuine
      bugs, gaps, or quality issues — verify each is real before fixing.

## Discovered along the way

(Empty — add anything found that isn't today's task, with enough detail for
a future session to act on it without re-discovering it from scratch.)

## Session log

(Empty — each run appends a dated entry: what changed, what's green, what's
still open, anything needing a decision, and what you deliberately stayed
away from because it looked like active manual work.)
