import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RESPONSE_JSON_SCHEMA } from '../src/services/agent-supervisor.service.js';

const supervisorSource = readFileSync('src/services/agent-supervisor.service.ts', 'utf8');
const actionsSource = readFileSync('src/services/agent-actions.service.ts', 'utf8');
const rulesetSource = readFileSync('src/services/agent-ruleset.service.ts', 'utf8');
const agentLogDomainSource = readFileSync('src/domain/agent-log.ts', 'utf8');
const workerSource = readFileSync('src/worker/index.ts', 'utf8');
const serverSource = readFileSync('src/control/server.ts', 'utf8');

describe('AI supervisor: never a path to a destructive action', () => {
  it('agent-actions.service.ts cannot call hardResetBot or drainBot', () => {
    expect(actionsSource).not.toContain('hardResetBot');
    expect(actionsSource).not.toContain('drainBot');
    expect(actionsSource).not.toMatch(/performHardReset/);
  });

  it('the action vocabulary itself has no destructive/reset kind', () => {
    expect(agentLogDomainSource).not.toMatch(/'hard_reset'/);
    expect(agentLogDomainSource).not.toMatch(/'drain/);
  });

  it('resume_bot is deliberately absent from the AI-proposable vocabulary', () => {
    // Resuming an idle-but-ready bot is handled as deterministic pre-AI
    // self-healing (runSelfHealing), not left to depend on the model
    // proposing it -- see agent-supervisor.service.ts. The domain file's own
    // explanatory comment says "resume_bot" in prose, so this checks for a
    // real schema variant (a z.literal declaration), not the bare word.
    expect(agentLogDomainSource).not.toMatch(/z\.literal\('resume_bot'\)/);
    expect(supervisorSource).toContain('runSelfHealing');
    expect(supervisorSource).toContain('getOperatorIdleStatus');
  });
});

describe('AI supervisor: self-healing runs independently of the AI call', () => {
  it('resumes before the OpenAI key/circuit/budget checks, not after', () => {
    // Anchored on the specific guard clauses inside runSupervisorCycle, not
    // the bare 'env.OPENAI_API_KEY' string -- that also appears earlier in
    // the file inside callSupervisorModel's request headers, which would
    // make a plain first-occurrence search find the wrong one.
    const selfHealIndex = supervisorSource.indexOf('runSelfHealing(idleBeforeSelfHeal)');
    const openAiKeyCheckIndex = supervisorSource.indexOf('if (!env.OPENAI_API_KEY)');
    expect(selfHealIndex).toBeGreaterThan(-1);
    expect(openAiKeyCheckIndex).toBeGreaterThan(-1);
    expect(selfHealIndex).toBeLessThan(openAiKeyCheckIndex);
  });

  it('every AI-skip path still writes a log entry instead of going silent', () => {
    expect(supervisorSource).toContain("skippedReason: 'openai_not_configured'");
    expect(supervisorSource).toContain("skippedReason: 'circuit_open'");
    expect(supervisorSource).toContain("skippedReason: 'budget_exhausted'");
    expect(supervisorSource).toContain("skippedReason: 'call_failed'");
  });
});

describe('AI supervisor: shares the existing OpenAI budget and circuit ledgers', () => {
  it('reserves against the same daily AI spend cap real enrichment draws from, not a separate one', () => {
    expect(supervisorSource).toContain('tryReserveDailyAiBudget');
    expect(supervisorSource).toContain('settings.hardAiSpendGbpPerDay');
    expect(supervisorSource).toContain('env.OPENAI_BUDGET_RESERVATION_GBP_PER_CALL');
    expect(supervisorSource).toContain('releaseDailyAiBudget');
  });

  it('trips and respects the same OpenAI circuit breaker as enrichment', () => {
    expect(supervisorSource).toContain('openAiCircuitAllowsRequest');
    expect(supervisorSource).toContain('recordOpenAiSuccess');
    expect(supervisorSource).toContain('recordOpenAiFailure');
  });

  it('every proposed action is re-classified deterministically, never trusted from the model', () => {
    expect(supervisorSource).toContain('classifyAgentAction(action, { settings, campaigns })');
  });
});

describe('AI supervisor: can tell a stale failure history from a live one', () => {
  // Regression test for a real production incident: the cycle repeatedly
  // paused the bot / disabled publishing across multiple runs (23:53, 00:09,
  // 05:23 on 2026-09-13/14) over the exact same publication failures, which
  // turned out to be 17-day-old records from before an unrelated schema fix
  // had already shipped. queues.publication.failed/completed never decrease,
  // so the model had no way to tell "old, already fixed" from "live" without
  // a timestamp -- this asserts the snapshot now carries one, and that the
  // model is actually told to use it, rather than just adding an unused field.
  it('gives the snapshot a per-failure timestamp and a live-retryable count, not just cumulative totals', () => {
    expect(supervisorSource).toContain('lastAttemptAt: item.updatedAt');
    expect(supervisorSource).toContain('nextRetryAt: item.nextRetryAt ?? null');
    expect(supervisorSource).toContain('retryableCandidateCount: retryableCandidateIds.length');
    expect(supervisorSource).toContain("now: new Date().toISOString()");
  });

  it('instructs the model to judge freshness from lastAttemptAt, not the cumulative queue totals', () => {
    expect(supervisorSource).toContain('recentFailures[].lastAttemptAt');
    expect(supervisorSource).toContain('cumulative counts that never decrease');
  });

  it('tells the model not to re-pause over a stale finding it (or an operator) may have already reversed', () => {
    expect(supervisorSource).toMatch(/genuinely recent lastAttemptAt/);
    expect(supervisorSource).toContain('not a reason to re-take an action');
  });
});

describe('AI supervisor: ruleset is exhaustive against the action schema', () => {
  it('has one classification case per action kind declared in the schema', () => {
    const kindMatches = [...agentLogDomainSource.matchAll(/z\.literal\('([a-z_]+)'\)/g)].map(match => match[1]);
    expect(kindMatches.length).toBeGreaterThan(10);
    for (const kind of kindMatches) {
      expect(rulesetSource).toContain(`case '${kind}'`);
    }
  });

  it('falls through to a throw, not a default tier, for anything unrecognised', () => {
    expect(rulesetSource).toContain('Unclassified agent action kind');
    expect(rulesetSource).not.toMatch(/default:\s*return \{ action, valid: true/);
  });
});

describe('AI supervisor: wired into the worker scheduler and control API', () => {
  it('registers a recurring scheduler distinct from coverage-plan and system-reconcile', () => {
    expect(workerSource).toContain("'ai-supervisor-v1'");
    expect(workerSource).toContain("name: 'supervisor-cycle'");
    expect(workerSource).toContain('runSupervisorCycle(trigger)');
  });

  it('exposes log, recommendations, approve, dismiss and a manual run-now', () => {
    expect(serverSource).toContain("app.get('/api/agent/log'");
    expect(serverSource).toContain("app.get('/api/agent/recommendations'");
    expect(serverSource).toContain("app.post('/api/agent/recommendations/:id/approve', requireCsrf");
    expect(serverSource).toContain("app.post('/api/agent/recommendations/:id/dismiss', requireCsrf");
    expect(serverSource).toContain("app.post('/api/agent/run-now', requireCsrf");
  });

  it('re-validates a recommendation against current state before approving it', () => {
    // Bounded by the next route registration, not the first '});' -- the
    // handler's own early-return bodies (e.g. the 404 branch) end in '});'
    // well before the assertions below, which would truncate the slice.
    const approveStart = serverSource.indexOf("/api/agent/recommendations/:id/approve");
    const approveEnd = serverSource.indexOf("/api/agent/recommendations/:id/dismiss", approveStart);
    const approveHandler = serverSource.slice(approveStart, approveEnd);
    expect(approveHandler).toContain('classifyAgentAction(record.action');
    expect(approveHandler).toContain("if (!reclassified.valid)");
  });
});

describe('AI supervisor: OpenAI strict json_schema compliance', () => {
  // Regression test for a real production failure: every action variant's
  // 'kind' discriminator was declared as a bare `{ const: '...' }`, which is
  // valid JSON Schema in general but is rejected by OpenAI's strict
  // json_schema mode with "schema must have a 'type' key" -- confirmed
  // directly against the live API (HTTP 400, invalid_json_schema) after
  // this PR's supervisor cycle was first deployed. A schema this shape
  // parses fine locally (it's never sent through a JSON Schema validator in
  // this codebase) and only fails once OpenAI itself rejects it, so this
  // walks the actual schema object structurally instead of trusting that.
  function assertEveryLeafHasType(node: unknown, path: string): void {
    if (node === null || typeof node !== 'object') return;
    const schema = node as Record<string, unknown>;
    if ('anyOf' in schema) {
      (schema.anyOf as unknown[]).forEach((variant, index) => assertEveryLeafHasType(variant, `${path}.anyOf[${index}]`));
      return;
    }
    expect(schema.type, `${path} is missing a "type" key`).toBeTruthy();
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, value] of Object.entries(schema.properties as Record<string, unknown>)) {
        assertEveryLeafHasType(value, `${path}.properties.${key}`);
      }
    }
    if (schema.items) {
      assertEveryLeafHasType(schema.items, `${path}.items`);
    }
  }

  it('every schema node (outside an anyOf wrapper) declares an explicit type', () => {
    assertEveryLeafHasType(RESPONSE_JSON_SCHEMA, 'RESPONSE_JSON_SCHEMA');
  });
});
