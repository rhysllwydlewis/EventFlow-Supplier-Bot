# Supplier Bot Operator

The operator is the "boots on the ground" for the deployed bot. Once a day it
logs into the live Control Centre, reads the bot's health, deals with the
supervisor's pending recommendations under a fixed written policy, adds an
outside-in Railway check, and writes a dated run log. It tells the owner only
when something needs them.

It is separate from the other two automations:

| | Looks at | Acts on |
| --- | --- | --- |
| Dev-Ops Assistant routine | the code | the repo (PRs, tests, merges) |
| In-app supervisor (`agent-supervisor.service.ts`) | the bot's own state, every 6h | auto-applies safety-direction changes, queues the rest |
| **Operator** | the live deployment, from outside | the approval queue, within the policy below |

Code: `src/operator/` (policy, client, health assessment, run log) and
`src/scripts/supplier-bot-operator.ts` (CLI). Policy lives in code, not in a
prompt, for the same reason `agent-ruleset.service.ts` does: the decision about
what may happen without a human must not depend on a model's reading of text.

## Running it

```
CONTROL_ADMIN_KEY=... npm run build
CONTROL_ADMIN_KEY=... npm run operator -- --url https://<control-host> [--apply] \
  [--log-dir docs/operator-runs] [--railway-json observation.json] [--stale-hours 168]
```

- **Dry run by default.** Nothing on the bot changes unless `--apply` is passed.
  A dry run still logs in (and out) and writes a log.
- The key is read from `CONTROL_ADMIN_KEY` only, sent only over HTTPS (or
  localhost), JSON-encoded (a hand-built JSON body breaks if the key contains a
  quote or backslash; the server answers 500), and never written to the log.
- Exit code `0`: nothing needs the owner. `2`: the owner should be told.
  `1`: the script itself failed.

## What it checks

From the Control Centre: `/health`, `/ready`, `/api/status` (settings, worker
heartbeat, queues, spend, idle alert), `/api/compliance-overview`,
`/api/campaigns`, `/api/agent/log` and `/api/agent/recommendations`. From
Railway (supplied by the routine as `--railway-json`): the latest deployment
status of the control and worker services and a count of recent error lines.

| Finding | Severity |
| --- | --- |
| control `/health` or `/ready` failing, no fresh worker, idle alert, emergency stop, bad Railway deployment (FAILED/CRASHED), operator cannot log in | **alert** (notifies the owner) |
| bot paused/stopped, queue backlog > 100, supervisor silent > 13h or skipping cycles, AI spend ≥ 80% of the soft cap, compliance backlog, Railway error lines | warn (logged) |
| any watched setting changed since the previous run (and by whom) | info (logged) |

## Approval policy

Every pending recommendation gets exactly one outcome. The checks run in this
order and the first match wins.

| Outcome | Rule | When |
| --- | --- | --- |
| dismiss | `invalid` | the server's own ruleset now says it is invalid (e.g. the campaign was deleted) |
| dismiss | `no_longer_loosening` | against current state it is a no-op or a safety-direction change |
| dismiss | `superseded` | a newer pending request of the same kind exists for the same campaign (the supervisor re-proposes a slightly different scope every cycle once a campaign plateaus; only the latest is its current view) |
| dismiss | `stale` | pending for more than 7 days (the supervisor re-proposes anything still relevant) |
| escalate | `owner_only` | going live, enabling publishing / claim notices / marketing / SEO indexing, raising either AI spend cap, lowering the quality bar, activating a campaign. **Never approved**, however fresh |
| approve | `allowlisted` | `set_discovery_enabled=true` or `set_refresh_enabled=true`, **only** while mode is `shadow`/`dry_run` and publishing, marketing and SEO indexing are all off (the Phase 3 safety contract) |
| escalate | `allowlist_precondition_failed` | an allowlisted kind, but the bot is live or an outward-facing control is on |
| escalate | `owner_decision` | any other loosening: scope widening, higher daily limits or crawl caps, and so on |

Safety properties:

- The allowlist is two entries long on purpose. Extending it is a code change
  with a test in `tests/operator-policy.test.ts`, reviewed like any other.
- At most 3 approvals per run, whatever the policy says.
- The control service re-validates every approval against current state
  server-side; the operator cannot make it apply something it considers invalid.
- A dismissed request is not lost: its full action payload is in the run log,
  and the supervisor will propose it again if it is still relevant.
- The operator only calls login, logout, the read endpoints, and the
  per-recommendation `approve` / `dismiss`. It never calls `/api/settings`,
  `/api/control/*` (play, pause, drain, emergency-stop, hard-reset) or any
  run-now endpoint.

## Run log

Each run writes `<runId>.json` and `<runId>.md` (UTC, e.g.
`2026-10-10T081500Z`) to `docs/operator-runs/` **on the
`claude/supplier-bot-operator` branch**, which holds log files only and is
never merged. Every file records: settings snapshot, supervisor status, queue
and spend metrics, compliance counts, findings, every recommendation with its
decision, rule, full action payload and outcome, the owner queue, and why the
owner was or was not notified.

`schemaVersion: 1` JSON is deliberately machine-readable so the in-app
supervisor can consume it later (for example a small endpoint that accepts a
run summary and adds "last operator run" to the supervisor's snapshot). That
integration is not built.

### Notification rules

The owner is notified when a run has an **alert**, or an owner decision that
was not in the previous run (matched by a fingerprint of the action, so a
supervisor re-wording its reason does not count as new), or the same decisions
have been waiting 7 days (a reminder). Otherwise the run is silent apart from
the log.

## Daily routine

"Supplier Bot Operator" runs once a day in a fresh session of the same
environment as the Dev-Ops Assistant. It needs `CONTROL_ADMIN_KEY` in that
environment's variables and the Railway connector for the outside check. Its
steps:

1. Get a clone of this repo; branch `claude/supplier-bot-operator` from
   `origin/main` (or continue it), merging the latest `origin/main`.
2. `npm ci && npm run build`.
3. Railway pass using read-only tools only (deployment status and recent error
   lines for `supplier-bot-control` and `supplier-bot-worker` in production);
   write the observation JSON.
4. `npm run operator -- --url <control url> --apply --railway-json <file>`.
5. Commit the new files under `docs/operator-runs/` and push the log branch.
6. Final message: `NEEDS YOU: ...` with the script's notify reasons, or a
   one-line `ALL CLEAR`.

If the key is missing, login is rejected, or the build fails, the run stops and
says so; it does not improvise API calls.

## Known gaps

- Nothing yet feeds the run log into the in-app supervisor (see above).
- The operator cannot tell whether the supervisor is *enabled* beyond "it has
  logged a cycle in the last 13 hours"; production's `OPENAI_API_KEY` is not
  readable from outside.
- Queue `failed` counts are cumulative (BullMQ), so the operator logs them but
  does not alert on them; the supervisor's freshness logic is the better judge.
