import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentActionRecord, AgentLogEntry } from '../src/domain/agent-log.js';
import { southWalesVenuePilot, type Campaign } from '../src/domain/campaign.js';
import { defaultSettings, type BotSettings } from '../src/domain/settings.js';
import { assess, redactLogLine, type AssessInput } from '../src/operator/assess.js';
import { ControlApiError, type ControlClient, type StatusSnapshot } from '../src/operator/client.js';
import { MAX_APPROVALS_PER_RUN, loadPreviousRun, renderMarkdown, runOperator, writeRunLog } from '../src/operator/run.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const campaign: Campaign = { ...southWalesVenuePilot(), status: 'running' };

function status(settings: Partial<BotSettings> = {}, overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    version: '0.8.0',
    settings: { ...defaultSettings(), runState: 'running', ...settings },
    workers: [{ processType: 'worker', status: 'ready', fresh: true }],
    workerHealthy: true,
    operatorIdle: { idle: false, alert: false, cause: null, blockedReason: null },
    queues: { publication: { waiting: 0, active: 0, delayed: 0, completed: 10, failed: 1 } },
    metrics: { aiEstimatedCostGbpToday: 0.1 },
    safetyCeilings: {},
    ...overrides,
  };
}

function pending(id: string, action: AgentActionRecord['action'], hoursAgo = 1): AgentActionRecord {
  return { id, logEntryId: 'log', createdAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(), action, tier: 'guarded', status: 'pending_approval' };
}

const goodLog: AgentLogEntry = {
  id: 'l1',
  createdAt: new Date(NOW - 3_600_000).toISOString(),
  trigger: 'scheduler',
  kind: 'ai_cycle',
  selfHealNotes: [],
  findings: [],
  diary: 'ok',
  model: 'm',
  actionIds: [],
};

const complianceOk = { totalProfiles: 10, assessed: 10, pending: 0, publicationEligible: 5, review: 1, blocked: 4, seoReady: 3 };

class FakeClient {
  approved: string[] = [];
  dismissed: string[] = [];
  loggedOut = false;
  constructor(
    private readonly opts: {
      status?: StatusSnapshot;
      items?: AgentActionRecord[];
      loginError?: ControlApiError;
      healthy?: boolean;
      noCompliance?: boolean;
    } = {},
  ) {}
  probe = vi.fn(async () => ({ ok: this.opts.healthy ?? true, httpStatus: this.opts.healthy === false ? 503 : 200, body: {} }));
  login = vi.fn(async () => {
    if (this.opts.loginError) throw this.opts.loginError;
  });
  logout = vi.fn(async () => {
    this.loggedOut = true;
  });
  status = vi.fn(async () => this.opts.status ?? status());
  compliance = vi.fn(async () => (this.opts.noCompliance ? null : complianceOk));
  campaigns = vi.fn(async () => [campaign]);
  agentLog = vi.fn(async () => [goodLog]);
  pendingRecommendations = vi.fn(async () => this.opts.items ?? []);
  approve = vi.fn(async (id: string) => {
    this.approved.push(id);
    return { ok: true, httpStatus: 200, detail: 'applied' };
  });
  dismiss = vi.fn(async (id: string) => {
    this.dismissed.push(id);
    return { ok: true, httpStatus: 204, detail: '' };
  });
}

const asClient = (fake: FakeClient): ControlClient => fake as unknown as ControlClient;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'operator-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const opts = (apply: boolean, extra: object = {}) => ({ apply, logDir: dir, railway: null, now: () => NOW, ...extra });
const scope = (id: string, cats: string[], hoursAgo: number) =>
  pending(id, { kind: 'adjust_campaign_scope', campaignId: campaign.id, categories: cats, locations: ['South Wales'], reason: 'r' }, hoursAgo);

describe('runOperator', () => {
  it('a dry run decides but changes nothing', async () => {
    const fake = new FakeClient({ items: [scope('a', ['Venues', 'Florists'], 30), scope('b', ['Venues', 'Catering'], 2)] });
    const log = await runOperator(asClient(fake), 'https://bot.example', opts(false));
    expect(fake.approve).not.toHaveBeenCalled();
    expect(fake.dismiss).not.toHaveBeenCalled();
    expect(log.recommendations.map(item => [item.id, item.decision])).toEqual([['a', 'dismiss'], ['b', 'escalate']]);
    expect(log.counts).toMatchObject({ pending: 2, approved: 0, dismissed: 0, escalated: 1 });
    expect(fake.loggedOut).toBe(true);
  });

  it('apply dismisses superseded items and leaves the owner decision pending', async () => {
    const fake = new FakeClient({ items: [scope('a', ['Venues', 'Florists'], 30), scope('b', ['Venues', 'Catering'], 2)] });
    const log = await runOperator(asClient(fake), 'https://bot.example', opts(true));
    expect(fake.dismissed).toEqual(['a']);
    expect(fake.approved).toEqual([]);
    expect(log.counts).toMatchObject({ dismissed: 1, approved: 0, escalated: 1 });
    expect(log.notifyOwner.needed).toBe(true);
  });

  it('approves allowlisted items (shadow, outward controls off) and applies them', async () => {
    const shadow = status({ mode: 'shadow', discoveryEnabled: false, refreshEnabled: false });
    const items = [
      pending('d1', { kind: 'set_discovery_enabled', value: true, reason: 'r' }),
      pending('r1', { kind: 'set_refresh_enabled', value: true, reason: 'r' }),
    ];
    const fake = new FakeClient({ status: shadow, items });
    const log = await runOperator(asClient(fake), 'https://bot.example', opts(true));
    expect(fake.approved.sort()).toEqual(['d1', 'r1']);
    expect(log.counts).toMatchObject({ approved: 2, escalated: 0 });
    expect(MAX_APPROVALS_PER_RUN).toBeGreaterThanOrEqual(2);
  });

  it('a failed approval (server says no longer valid) is escalated, not silently lost', async () => {
    const shadow = status({ mode: 'shadow', discoveryEnabled: false });
    const fake = new FakeClient({ status: shadow, items: [pending('d1', { kind: 'set_discovery_enabled', value: true, reason: 'r' })] });
    fake.approve.mockResolvedValueOnce({ ok: false, httpStatus: 409, detail: 'No longer valid' });
    const log = await runOperator(asClient(fake), 'https://bot.example', opts(true));
    expect(log.counts.approved).toBe(0);
    expect(log.ownerQueue).toHaveLength(1);
  });

  it('does not re-notify for an owner decision already reported, but reminds after a week', async () => {
    const items = [scope('b', ['Venues', 'Catering'], 2)];
    const first = await runOperator(asClient(new FakeClient({ items })), 'https://bot.example', opts(true));
    await writeRunLog(first, null, dir);
    expect(first.notifyOwner.needed).toBe(true);

    const nextDay = await runOperator(asClient(new FakeClient({ items })), 'https://bot.example', opts(true, { now: () => NOW + 86_400_000 }));
    expect(nextDay.notifyOwner.needed).toBe(false);
    expect(nextDay.ownerQueue[0]?.firstSeenAt).toBe(first.startedAt);

    await writeRunLog(nextDay, first, dir);
    const nextWeek = await runOperator(asClient(new FakeClient({ items })), 'https://bot.example', opts(true, { now: () => NOW + 8 * 86_400_000, staleAfterHours: 24 * 30 }));
    expect(nextWeek.notifyOwner.reasons[0]).toMatch(/REMINDER/);
  });

  it('turns an unhealthy bot into an alert that notifies the owner', async () => {
    const fake = new FakeClient({ status: status({}, { workerHealthy: false }) });
    const log = await runOperator(asClient(fake), 'https://bot.example', opts(true));
    expect(log.findings).toContainEqual(expect.objectContaining({ severity: 'alert', code: 'worker_unhealthy' }));
    expect(log.notifyOwner.needed).toBe(true);
  });

  it('still produces a log and an alert when login is rejected', async () => {
    const fake = new FakeClient({ loginError: new ControlApiError('login rejected', 401) });
    const log = await runOperator(asClient(fake), 'https://bot.example', opts(true));
    expect(fake.status).not.toHaveBeenCalled();
    expect(log.findings[0]).toMatchObject({ severity: 'alert', code: 'operator_cannot_login' });
    expect(log.notifyOwner.needed).toBe(true);
  });

  it('a run that could not read the bot shows no settings and is not used as the next baseline', async () => {
    const good = await runOperator(asClient(new FakeClient({ status: status({ publishingEnabled: false }) })), 'https://bot.example', opts(true));
    await writeRunLog(good, null, dir);
    const failed = await runOperator(asClient(new FakeClient({ loginError: new ControlApiError('login rejected', 401) })), 'https://bot.example', opts(true, { now: () => NOW + 3_600_000 }));
    expect(failed.settings).toBeNull();
    expect(renderMarkdown(failed, good)).toContain('could not be read');
    expect(renderMarkdown(failed, good)).not.toContain('Supervisor:');
    await writeRunLog(failed, good, dir);
    expect((await loadPreviousRun(dir))?.runId).toBe(good.runId);
  });

  it('warns when the pending list may have been truncated', async () => {
    const items = Array.from({ length: 200 }, (_, i) => pending(`s${i}`, { kind: 'adjust_daily_hard_limit', value: 100 + i, reason: 'r' }, i + 1));
    const log = await runOperator(asClient(new FakeClient({ items })), 'https://bot.example', opts(false));
    expect(log.findings.map(item => item.code)).toContain('recommendations_truncated');
  });

  it('records a Railway deployment failure as an alert', async () => {
    const railway = { checkedAt: new Date(NOW).toISOString(), services: [{ name: 'supplier-bot-worker', status: 'CRASHED' }] };
    const log = await runOperator(asClient(new FakeClient()), 'https://bot.example', opts(false, { railway }));
    expect(log.findings).toContainEqual(expect.objectContaining({ code: 'deploy_bad', severity: 'alert' }));
  });

  it('reports a settings change since the previous run', async () => {
    const first = await runOperator(asClient(new FakeClient({ status: status({ publishingEnabled: false }) })), 'https://bot.example', opts(true));
    await writeRunLog(first, null, dir);
    const second = await runOperator(asClient(new FakeClient({ status: status({ publishingEnabled: true, updatedBy: 'control-admin' }) })), 'https://bot.example', opts(false, { now: () => NOW + 3_600_000 }));
    const change = second.findings.find(item => item.code === 'settings_changed');
    expect(change?.message).toContain('publishingEnabled: false -> true');
    expect(change?.message).toContain('control-admin');
  });
});

describe('runOperator: notification state', () => {
  it('does not tell the owner again when the supervisor re-proposes a different payload for the same topic', async () => {
    const day1 = await runOperator(asClient(new FakeClient({ items: [scope('b', ['Venues', 'Catering'], 2)] })), 'https://bot.example', opts(true));
    await writeRunLog(day1, null, dir);
    expect(day1.notifyOwner.needed).toBe(true);

    const variant = scope('c', ['Venues', 'Florists', 'Hire'], 1);
    const day2 = await runOperator(asClient(new FakeClient({ items: [variant] })), 'https://bot.example', opts(true, { now: () => NOW + 86_400_000 }));
    expect(day2.ownerQueue[0]?.fingerprint).not.toBe(day1.ownerQueue[0]?.fingerprint);
    expect(day2.notifyOwner.needed).toBe(false);
    expect(day2.ownerQueue[0]?.firstSeenAt).toBe(day1.startedAt);
  });

  it('a dry run is never used as the baseline, so the next real run still notifies', async () => {
    const items = [scope('b', ['Venues', 'Catering'], 2)];
    const dry = await runOperator(asClient(new FakeClient({ items })), 'https://bot.example', opts(false));
    await writeRunLog(dry, null, dir);
    expect(await loadPreviousRun(dir)).toBeNull();
    const real = await runOperator(asClient(new FakeClient({ items })), 'https://bot.example', opts(true, { now: () => NOW + 3_600_000 }));
    expect(real.notifyOwner.needed).toBe(true);
    expect(real.notifyOwner.reasons[0]).toMatch(/NEW decision/);
  });
});

describe('runOperator: failures', () => {
  it('an API error after login produces an alert log and still logs out', async () => {
    const fake = new FakeClient();
    fake.status.mockRejectedValueOnce(new ControlApiError('GET /api/status failed with HTTP 500', 500));
    const log = await runOperator(asClient(fake), 'https://bot.example', opts(true));
    expect(log.findings[0]).toMatchObject({ severity: 'alert', code: 'operator_api_error' });
    expect(log.notifyOwner.needed).toBe(true);
    expect(fake.dismiss).not.toHaveBeenCalled();
    expect(fake.loggedOut).toBe(true);
  });

  it('one request failing mid-run does not lose the others or the log', async () => {
    const items = [scope('a', ['Venues', 'Florists'], 30), scope('z', ['Venues', 'Hire'], 20), scope('b', ['Venues', 'Catering'], 2)];
    const fake = new FakeClient({ items });
    fake.dismiss.mockRejectedValueOnce(new Error('socket hang up'));
    const log = await runOperator(asClient(fake), 'https://bot.example', opts(true));
    expect(fake.dismiss).toHaveBeenCalledTimes(2);
    expect(log.recommendations.find(item => item.id === 'a')?.outcome).toMatchObject({ applied: false });
    expect(log.recommendations.find(item => item.id === 'a')?.outcome.detail).toContain('socket hang up');
    expect(log.recommendations.find(item => item.id === 'z')?.outcome.applied).toBe(true);
    expect(log.counts.dismissed).toBe(1);
  });

  it('warns when compliance is unreadable, and when Railway data is incomplete', async () => {
    const railway = { checkedAt: new Date(NOW).toISOString(), services: [{ name: 'supplier-bot-control', status: 'SUCCESS' }] };
    const log = await runOperator(asClient(new FakeClient({ noCompliance: true })), 'https://bot.example', opts(false, { railway }));
    const codes = log.findings.map(item => item.code);
    expect(codes).toEqual(expect.arrayContaining(['compliance_unavailable', 'railway_incomplete']));
  });

  it('scrubs credentials from Railway log samples before they reach the stored log', async () => {
    const railway = {
      checkedAt: new Date(NOW).toISOString(),
      services: [{ name: 'supplier-bot-control', status: 'SUCCESS' }, { name: 'supplier-bot-worker', status: 'SUCCESS' }],
      recentErrors: { count: 1, windowHours: 24, samples: ['connect failed mongodb://admin:hunter2@db.internal:27017/x token=abc123secret'] },
    };
    const log = await runOperator(asClient(new FakeClient()), 'https://bot.example', opts(false, { railway }));
    const stored = JSON.stringify(log);
    expect(stored).not.toContain('hunter2');
    expect(stored).not.toContain('abc123secret');
  });
});

describe('redactLogLine', () => {
  it.each([
    ['postgres://user:pa55@host/db', 'pa55'],
    ['Authorization: Bearer abcdef0123456789', 'abcdef0123456789'],
    ['x-csrf-token: Zm9vYmFyYmF6cXV4', 'Zm9vYmFyYmF6cXV4'],
    ['key sk-abcdefghijklmnopqrstuvwxyz012345', 'sk-abcdefghijklmnopqrstuvwxyz012345'],
    ['sid 0123456789abcdef0123456789abcdef01234567', '0123456789abcdef0123456789abcdef01234567'],
  ])('removes the secret from %s', (line, secret) => {
    const out = redactLogLine(line);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('keeps ordinary lines readable and caps length', () => {
    expect(redactLogLine('queue crawl stalled for job 42')).toBe('queue crawl stalled for job 42');
    expect(redactLogLine('x '.repeat(400)).length).toBeLessThanOrEqual(250);
  });
});

describe('run log files', () => {
  it('writes a JSON and a Markdown file per run and reloads the newest as previous', async () => {
    const log = await runOperator(asClient(new FakeClient({ items: [scope('b', ['Venues', 'Catering'], 2)] })), 'https://bot.example', opts(true));
    const { jsonPath, mdPath } = await writeRunLog(log, null, dir);
    expect((await readdir(dir)).sort()).toEqual([`${log.runId}.json`, `${log.runId}.md`]);
    expect(await readFile(mdPath, 'utf8')).toContain('Waiting on the owner');
    expect(JSON.parse(await readFile(jsonPath, 'utf8')).schemaVersion).toBe(1);
    expect((await loadPreviousRun(dir))?.runId).toBe(log.runId);
    expect(renderMarkdown({ ...log, applied: false }, null)).toContain('dry run');
  });

  it('never contains the admin key or session material', async () => {
    const log = await runOperator(asClient(new FakeClient()), 'https://bot.example', opts(false));
    const text = JSON.stringify(log);
    expect(text).not.toMatch(/csrf|cookie|CONTROL_ADMIN_KEY/i);
  });

  it('returns null when there is no previous run', async () => {
    expect(await loadPreviousRun(join(dir, 'missing'))).toBeNull();
  });
});

describe('assess', () => {
  const base = (): AssessInput => ({
    now: NOW,
    status: status(),
    compliance: complianceOk,
    agentLog: [goodLog],
    health: { ok: true, httpStatus: 200 },
    ready: { ok: true, httpStatus: 200 },
    railway: {
      checkedAt: 'x',
      services: [
        { name: 'supplier-bot-control', status: 'SUCCESS' },
        { name: 'supplier-bot-worker', status: 'SUCCESS' },
      ],
    },
    previousSettings: null,
  });

  it('is quiet when everything is healthy', () => {
    expect(assess(base())).toEqual([]);
  });

  it('flags a silent or skipping supervisor, high spend and queue backlog', () => {
    const input = base();
    input.agentLog = [{ ...goodLog, createdAt: new Date(NOW - 20 * 3_600_000).toISOString(), kind: 'ai_skipped', skippedReason: 'circuit_open' }];
    input.status = status({}, { metrics: { aiEstimatedCostGbpToday: 4.5 }, queues: { crawl: { waiting: 500, active: 0, delayed: 0, completed: 0, failed: 0 } } });
    const codes = assess(input).map(item => item.code);
    expect(codes).toEqual(expect.arrayContaining(['supervisor_silent', 'supervisor_skipped', 'ai_spend_high', 'queue_backlog']));
  });

  it('flags control being down and emergency stop as alerts', () => {
    const input = base();
    input.health = { ok: false, httpStatus: 502 };
    input.status = status({ runState: 'emergency_stopped' });
    const alerts = assess(input).filter(item => item.severity === 'alert').map(item => item.code);
    expect(alerts).toEqual(expect.arrayContaining(['control_unhealthy', 'emergency_stopped']));
  });
});
