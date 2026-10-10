import { describe, expect, it } from 'vitest';
import type { AgentAction, AgentActionRecord } from '../src/domain/agent-log.js';
import { southWalesVenuePilot, type Campaign } from '../src/domain/campaign.js';
import { defaultSettings, type BotSettings } from '../src/domain/settings.js';
import { decideRecommendations, type PolicyContext } from '../src/operator/policy.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();

const campaign: Campaign = { ...southWalesVenuePilot(), status: 'running' };

function ctx(overrides: Partial<BotSettings> = {}, campaigns: Campaign[] = [campaign]): PolicyContext {
  return { now: NOW, settings: { ...defaultSettings(), ...overrides }, campaigns, staleAfterHours: 24 * 7 };
}

let counter = 0;
function record(action: AgentAction, createdHoursAgo = 1): AgentActionRecord {
  counter += 1;
  return {
    id: `agentaction_${counter}`,
    logEntryId: 'log_1',
    createdAt: hoursAgo(createdHoursAgo),
    action,
    tier: 'guarded',
    status: 'pending_approval',
  };
}

const reason = 'test';

describe('operator policy: allowlist', () => {
  it.each(['set_discovery_enabled', 'set_refresh_enabled'] as const)('approves %s=true while shadow with outward controls off', kind => {
    const [verdict] = decideRecommendations([record({ kind, value: true, reason })], ctx({ mode: 'shadow', discoveryEnabled: false, refreshEnabled: false }));
    expect(verdict).toMatchObject({ decision: 'approve', rule: 'allowlisted' });
  });

  it('escalates the same request once the bot is live', () => {
    const [verdict] = decideRecommendations(
      [record({ kind: 'set_discovery_enabled', value: true, reason })],
      ctx({ mode: 'live', discoveryEnabled: false }),
    );
    expect(verdict).toMatchObject({ decision: 'escalate', rule: 'allowlist_precondition_failed' });
  });

  it('escalates it if any outward-facing control is on, even in shadow', () => {
    for (const flag of ['publishingEnabled', 'marketingEnabled', 'seoIndexingEnabled'] as const) {
      const [verdict] = decideRecommendations(
        [record({ kind: 'set_refresh_enabled', value: true, reason })],
        ctx({ mode: 'shadow', refreshEnabled: false, [flag]: true }),
      );
      expect(verdict?.decision, flag).toBe('escalate');
    }
  });
});

describe('operator policy: never approved', () => {
  const settings: Partial<BotSettings> = { mode: 'shadow', softAiSpendGbpPerDay: 5, hardAiSpendGbpPerDay: 10, minimumPublicationQuality: 85 };
  const actions: AgentAction[] = [
    { kind: 'set_mode', value: 'live', reason },
    { kind: 'set_publishing_enabled', value: true, reason },
    { kind: 'set_claim_notices_enabled', value: true, reason },
    { kind: 'set_marketing_enabled', value: true, reason },
    { kind: 'set_seo_indexing_enabled', value: true, reason },
    { kind: 'adjust_soft_ai_spend_cap', value: 6, reason },
    { kind: 'adjust_hard_ai_spend_cap', value: 11, reason },
    { kind: 'adjust_minimum_publication_quality', value: 80, reason },
    { kind: 'set_campaign_status', campaignId: campaign.id, value: 'running', reason },
  ];

  it.each(actions.map(action => [action.kind, action] as const))('%s is escalated, never approved', (_kind, action) => {
    const campaigns = [{ ...campaign, status: 'draft' as const }];
    const [verdict] = decideRecommendations([record(action)], ctx(settings, campaigns));
    expect(verdict).toMatchObject({ decision: 'escalate', rule: 'owner_only' });
  });

  it('other loosening (scope widening, higher limits) is an owner decision, not approvable', () => {
    const verdicts = decideRecommendations(
      [
        record({ kind: 'adjust_campaign_scope', campaignId: campaign.id, categories: ['Venues', 'Florists'], locations: ['South Wales'], reason }),
        record({ kind: 'adjust_daily_hard_limit', value: 50, reason }),
        record({ kind: 'adjust_max_crawls_per_day', value: 500, reason }),
      ],
      ctx({ dailyHardLimit: 10, maxCrawlsPerDay: 100 }),
    );
    expect(verdicts.map(item => item.decision)).toEqual(['escalate', 'escalate', 'escalate']);
  });
});

describe('operator policy: dismissals', () => {
  it('dismisses a request whose campaign no longer exists', () => {
    const [verdict] = decideRecommendations(
      [record({ kind: 'adjust_campaign_scope', campaignId: 'campaign_gone', categories: ['Venues'], locations: ['Wales'], reason })],
      ctx(),
    );
    expect(verdict).toMatchObject({ decision: 'dismiss', rule: 'invalid' });
  });

  it('dismisses a request that is no longer a loosening change', () => {
    const [verdict] = decideRecommendations([record({ kind: 'adjust_daily_target', value: 5, reason })], ctx({ dailyTarget: 10 }));
    expect(verdict).toMatchObject({ decision: 'dismiss', rule: 'no_longer_loosening' });
  });

  it('keeps only the newest pending request per kind and campaign', () => {
    const older = record({ kind: 'adjust_campaign_scope', campaignId: campaign.id, categories: ['Venues', 'Florists'], locations: ['South Wales'], reason }, 30);
    const newer = record({ kind: 'adjust_campaign_scope', campaignId: campaign.id, categories: ['Venues', 'Catering'], locations: ['South Wales'], reason }, 2);
    const verdicts = decideRecommendations([older, newer], ctx());
    expect(verdicts.find(item => item.id === older.id)).toMatchObject({ decision: 'dismiss', rule: 'superseded' });
    expect(verdicts.find(item => item.id === newer.id)).toMatchObject({ decision: 'escalate' });
  });

  it('does not treat different kinds, or different campaigns, as superseding each other', () => {
    const other: Campaign = { ...campaign, id: 'campaign_other' };
    const verdicts = decideRecommendations(
      [
        record({ kind: 'adjust_campaign_scope', campaignId: campaign.id, categories: ['Venues', 'Florists'], locations: ['South Wales'], reason }, 30),
        record({ kind: 'adjust_campaign_scope', campaignId: other.id, categories: ['Venues', 'Florists'], locations: ['South Wales'], reason }, 2),
        record({ kind: 'adjust_campaign_daily_limits', campaignId: campaign.id, dailyTarget: 20, dailyHardLimit: 20, reason }, 2),
      ],
      ctx({}, [campaign, other]),
    );
    expect(verdicts.map(item => item.decision)).toEqual(['escalate', 'escalate', 'escalate']);
  });

  it('dismisses stale requests, even an owner-only one', () => {
    const [verdict] = decideRecommendations([record({ kind: 'set_publishing_enabled', value: true, reason }, 24 * 8)], ctx({ mode: 'shadow' }));
    expect(verdict).toMatchObject({ decision: 'dismiss', rule: 'stale' });
  });

  it('ignores records that are not pending', () => {
    const done = { ...record({ kind: 'set_discovery_enabled', value: true, reason }), status: 'approved' as const };
    expect(decideRecommendations([done], ctx())).toEqual([]);
  });
});

describe('operator policy: summaries and fingerprints', () => {
  it('describes a scope change as a diff against the current campaign', () => {
    const [verdict] = decideRecommendations(
      [record({ kind: 'adjust_campaign_scope', campaignId: campaign.id, categories: ['Venues', 'Florists'], locations: ['South Wales', 'Newport'], reason })],
      ctx(),
    );
    expect(verdict?.summary).toContain('categories +Florists');
    expect(verdict?.summary).toContain('locations +Newport');
  });

  it('gives identical requests the same fingerprint regardless of the supervisor’s reason text', () => {
    const a = record({ kind: 'adjust_daily_hard_limit', value: 50, reason: 'because A' });
    const b = record({ kind: 'adjust_daily_hard_limit', value: 50, reason: 'because B' });
    const [first, second] = decideRecommendations([a, b], ctx({ dailyHardLimit: 10 }));
    expect(first?.fingerprint).toBe(second?.fingerprint);
    const c = record({ kind: 'adjust_daily_hard_limit', value: 60, reason: 'because A' });
    expect(decideRecommendations([c], ctx({ dailyHardLimit: 10 }))[0]?.fingerprint).not.toBe(first?.fingerprint);
  });
});
