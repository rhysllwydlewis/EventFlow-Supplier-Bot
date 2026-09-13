import { describe, expect, it } from 'vitest';
import { southWalesVenuePilot, type Campaign } from '../src/domain/campaign.js';
import type { AgentAction } from '../src/domain/agent-log.js';
import { defaultSettings } from '../src/domain/settings.js';
import { classifyAgentAction } from '../src/services/agent-ruleset.service.js';

const settings = defaultSettings();
const campaign: Campaign = southWalesVenuePilot();
const ctx = { settings, campaigns: [campaign] };

function reason(kind: string): string {
  return `test reason for ${kind}`;
}

describe('AI supervisor ruleset: safety-direction actions are always auto', () => {
  it.each([
    { kind: 'pause_bot', reason: reason('pause_bot') },
    { kind: 'emergency_stop_bot', reason: reason('emergency_stop_bot') },
    { kind: 'retry_stuck_publication', candidateId: 'candidate_1', reason: reason('retry_stuck_publication') },
  ] as AgentAction[])('$kind is always auto', action => {
    expect(classifyAgentAction(action, ctx)).toMatchObject({ valid: true, tier: 'auto' });
  });
});

describe('AI supervisor ruleset: mode changes', () => {
  it('moving to a less risky mode is auto', () => {
    for (const value of ['off', 'dry_run', 'shadow'] as const) {
      expect(
        classifyAgentAction({ kind: 'set_mode', value, reason: reason('set_mode') }, { settings: { ...settings, mode: 'live' }, campaigns: [campaign] }),
      ).toMatchObject({ valid: true, tier: 'auto' });
    }
  });

  it('moving to live is guarded', () => {
    expect(
      classifyAgentAction({ kind: 'set_mode', value: 'live', reason: reason('set_mode') }, { settings: { ...settings, mode: 'shadow' }, campaigns: [campaign] }),
    ).toMatchObject({ valid: true, tier: 'guarded' });
  });

  it('staying at the same mode is auto (not a loosening move)', () => {
    expect(
      classifyAgentAction({ kind: 'set_mode', value: 'live', reason: reason('set_mode') }, { settings: { ...settings, mode: 'live' }, campaigns: [campaign] }),
    ).toMatchObject({ valid: true, tier: 'auto' });
  });
});

describe('AI supervisor ruleset: outward-facing toggles', () => {
  const toggleKinds = [
    'set_publishing_enabled',
    'set_claim_notices_enabled',
    'set_marketing_enabled',
    'set_seo_indexing_enabled',
    'set_discovery_enabled',
    'set_refresh_enabled',
  ] as const;

  it.each(toggleKinds)('%s: turning on is guarded, turning off is auto', kind => {
    const on = classifyAgentAction({ kind, value: true, reason: reason(kind) } as AgentAction, ctx);
    const off = classifyAgentAction({ kind, value: false, reason: reason(kind) } as AgentAction, ctx);
    expect(on).toMatchObject({ valid: true, tier: 'guarded' });
    expect(off).toMatchObject({ valid: true, tier: 'auto' });
  });
});

describe('AI supervisor ruleset: numeric ceilings only loosen when increased', () => {
  it('daily target: auto when decreasing or unchanged, guarded when increasing', () => {
    expect(
      classifyAgentAction({ kind: 'adjust_daily_target', value: settings.dailyTarget - 1, reason: reason('x') }, ctx),
    ).toMatchObject({ tier: 'auto' });
    expect(
      classifyAgentAction({ kind: 'adjust_daily_target', value: settings.dailyTarget, reason: reason('x') }, ctx),
    ).toMatchObject({ tier: 'auto' });
    expect(
      classifyAgentAction({ kind: 'adjust_daily_target', value: settings.dailyTarget + 1, reason: reason('x') }, ctx),
    ).toMatchObject({ tier: 'guarded' });
  });

  it('daily hard limit follows the same rule', () => {
    expect(
      classifyAgentAction({ kind: 'adjust_daily_hard_limit', value: settings.dailyHardLimit - 1, reason: reason('x') }, ctx),
    ).toMatchObject({ tier: 'auto' });
    expect(
      classifyAgentAction({ kind: 'adjust_daily_hard_limit', value: settings.dailyHardLimit + 1, reason: reason('x') }, ctx),
    ).toMatchObject({ tier: 'guarded' });
  });

  it('max crawls/day follows the same rule', () => {
    expect(
      classifyAgentAction({ kind: 'adjust_max_crawls_per_day', value: settings.maxCrawlsPerDay - 1, reason: reason('x') }, ctx),
    ).toMatchObject({ tier: 'auto' });
    expect(
      classifyAgentAction({ kind: 'adjust_max_crawls_per_day', value: settings.maxCrawlsPerDay + 1, reason: reason('x') }, ctx),
    ).toMatchObject({ tier: 'guarded' });
  });

  it('AI spend caps follow the same rule', () => {
    expect(
      classifyAgentAction({ kind: 'adjust_soft_ai_spend_cap', value: settings.softAiSpendGbpPerDay + 1, reason: reason('x') }, ctx),
    ).toMatchObject({ tier: 'guarded' });
    expect(
      classifyAgentAction({ kind: 'adjust_hard_ai_spend_cap', value: settings.hardAiSpendGbpPerDay - 1, reason: reason('x') }, ctx),
    ).toMatchObject({ tier: 'auto' });
  });

  it('minimum publication quality is inverted: a LOWER bar is the loosening direction', () => {
    expect(
      classifyAgentAction(
        { kind: 'adjust_minimum_publication_quality', value: settings.minimumPublicationQuality + 5, reason: reason('x') },
        ctx,
      ),
    ).toMatchObject({ tier: 'auto' });
    expect(
      classifyAgentAction(
        { kind: 'adjust_minimum_publication_quality', value: settings.minimumPublicationQuality - 5, reason: reason('x') },
        ctx,
      ),
    ).toMatchObject({ tier: 'guarded' });
  });
});

describe('AI supervisor ruleset: campaigns', () => {
  it('creating a draft campaign is always auto -- it has no live effect until activated', () => {
    expect(
      classifyAgentAction(
        { kind: 'create_campaign_draft', name: 'Cardiff caterers', categories: ['Catering'], locations: ['Cardiff'], reason: reason('x') },
        ctx,
      ),
    ).toMatchObject({ valid: true, tier: 'auto' });
  });

  it('activating a campaign is guarded; pausing/archiving is auto', () => {
    expect(
      classifyAgentAction({ kind: 'set_campaign_status', campaignId: campaign.id, value: 'running', reason: reason('x') }, ctx),
    ).toMatchObject({ valid: true, tier: 'guarded' });
    expect(
      classifyAgentAction({ kind: 'set_campaign_status', campaignId: campaign.id, value: 'paused', reason: reason('x') }, ctx),
    ).toMatchObject({ valid: true, tier: 'auto' });
    expect(
      classifyAgentAction({ kind: 'set_campaign_status', campaignId: campaign.id, value: 'archived', reason: reason('x') }, ctx),
    ).toMatchObject({ valid: true, tier: 'auto' });
  });

  it('widening a campaign\'s daily limits is guarded; narrowing is auto', () => {
    expect(
      classifyAgentAction(
        { kind: 'adjust_campaign_daily_limits', campaignId: campaign.id, dailyTarget: campaign.dailyTarget + 1, dailyHardLimit: campaign.dailyHardLimit, reason: reason('x') },
        ctx,
      ),
    ).toMatchObject({ valid: true, tier: 'guarded' });
    expect(
      classifyAgentAction(
        { kind: 'adjust_campaign_daily_limits', campaignId: campaign.id, dailyTarget: campaign.dailyTarget, dailyHardLimit: campaign.dailyHardLimit - 1, reason: reason('x') },
        ctx,
      ),
    ).toMatchObject({ valid: true, tier: 'auto' });
  });

  it('targeting a campaign that no longer exists is invalid, never silently auto-applied', () => {
    const result = classifyAgentAction(
      { kind: 'adjust_campaign_daily_limits', campaignId: 'campaign_does_not_exist', dailyTarget: 1, dailyHardLimit: 1, reason: reason('x') },
      ctx,
    );
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toBe('campaign_not_found');
  });
});

describe('AI supervisor ruleset: never allows a destructive action', () => {
  it('hard_reset is not a recognised action kind at all', () => {
    // agentActionSchema (domain/agent-log.ts) has no 'hard_reset' variant, so
    // this can only ever be constructed by bypassing the schema entirely --
    // exactly what a compromised or malfunctioning model response would have
    // to do. classifyAgentAction has no case for it and would throw rather
    // than default it to a tier, which this proves by casting past the type
    // system the way corrupted input would have to.
    const bogus = { kind: 'hard_reset', reason: 'anything' } as unknown as AgentAction;
    expect(() => classifyAgentAction(bogus, ctx)).toThrow(/Unclassified agent action kind/);
  });
});
