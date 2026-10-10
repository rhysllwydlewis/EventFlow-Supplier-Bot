import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentActionRecord, AgentLogEntry } from '../src/domain/agent-log.js';
import { southWalesVenuePilot, type Campaign } from '../src/domain/campaign.js';
import { defaultSettings, type BotSettings } from '../src/domain/settings.js';
import { assess, type AssessInput } from '../src/operator/assess.js';
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
  compliance = vi.fn(async () => null);
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

  it('records a Railway deployment failure as an alert', async () => {
    const railway = { checkedAt: new Date(NOW).toISOString(), services: [{ name: 'supplier-bot-worker', status: 'CRASHED' }] };
    const log = await runOperator(asClient(new FakeClient()), 'https://bot.example', opts(false, { railway }));
    expect(log.findings).toContainEqual(expect.objectContaining({ code: 'deploy_bad', severity: 'alert' }));
  });

  it('reports a settings change since the previous run', async () => {
    const first = await runOperator(asClient(new FakeClient({ status: status({ publishingEnabled: false }) })), 'https://bot.example', opts(false));
    await writeRunLog(first, null, dir);
    const second = await runOperator(asClient(new FakeClient({ status: status({ publishingEnabled: true, updatedBy: 'control-admin' }) })), 'https://bot.example', opts(false, { now: () => NOW + 3_600_000 }));
    const change = second.findings.find(item => item.code === 'settings_changed');
    expect(change?.message).toContain('publishingEnabled: false -> true');
    expect(change?.message).toContain('control-admin');
  });
});

describe('run log files', () => {
  it('writes a JSON and a Markdown file per run and reloads the newest as previous', async () => {
    const log = await runOperator(asClient(new FakeClient({ items: [scope('b', ['Venues', 'Catering'], 2)] })), 'https://bot.example', opts(false));
    const { jsonPath, mdPath } = await writeRunLog(log, null, dir);
    expect((await readdir(dir)).sort()).toEqual([`${log.runId}.json`, `${log.runId}.md`]);
    expect(await readFile(mdPath, 'utf8')).toContain('Waiting on the owner');
    expect(JSON.parse(await readFile(jsonPath, 'utf8')).schemaVersion).toBe(1);
    expect((await loadPreviousRun(dir))?.runId).toBe(log.runId);
    expect(renderMarkdown(log, null)).toContain('dry run');
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
    compliance: null,
    agentLog: [goodLog],
    health: { ok: true, httpStatus: 200 },
    ready: { ok: true, httpStatus: 200 },
    railway: { checkedAt: 'x', services: [{ name: 's', status: 'SUCCESS' }] },
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
