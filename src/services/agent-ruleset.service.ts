import type { Campaign } from '../domain/campaign.js';
import type { AgentAction, AgentActionTier } from '../domain/agent-log.js';
import type { BotSettings } from '../domain/settings.js';

export interface AgentRulesetContext {
  settings: BotSettings;
  campaigns: Campaign[];
}

export interface ClassifiedAgentAction {
  action: AgentAction;
  valid: boolean;
  tier: AgentActionTier;
  invalidReason?: string;
}

// The one rule this whole file exists to enforce, deterministically, in code
// the AI cannot influence: making the bot MORE conservative (paused,
// stricter quality, lower spend, narrower scope) is always safe to apply
// immediately. Making it LESS conservative (live, publishing, looser
// quality, higher spend, wider scope) always needs a human's explicit
// approval first. The model's own opinion of which tier an action belongs
// to is never consulted -- only the kind and the before/after values are.
const MODE_RISK_RANK: Record<BotSettings['mode'], number> = {
  off: 0,
  dry_run: 1,
  shadow: 2,
  live: 3,
};

export function classifyAgentAction(action: AgentAction, ctx: AgentRulesetContext): ClassifiedAgentAction {
  switch (action.kind) {
    case 'pause_bot':
    case 'emergency_stop_bot':
    case 'retry_stuck_publication':
      // Always safety-direction or self-healing with no lasting effect on
      // its own -- never needs a human to sign off first.
      return { action, valid: true, tier: 'auto' };

    case 'set_mode': {
      const loosening = MODE_RISK_RANK[action.value] > MODE_RISK_RANK[ctx.settings.mode];
      return { action, valid: true, tier: loosening ? 'guarded' : 'auto' };
    }

    case 'set_publishing_enabled':
    case 'set_claim_notices_enabled':
    case 'set_marketing_enabled':
    case 'set_seo_indexing_enabled':
    case 'set_discovery_enabled':
    case 'set_refresh_enabled':
      // Turning an outward-facing control OFF is always safe; turning it ON
      // widens what the bot does in the real world and needs a human.
      return { action, valid: true, tier: action.value ? 'guarded' : 'auto' };

    case 'adjust_daily_target':
      return { action, valid: true, tier: action.value > ctx.settings.dailyTarget ? 'guarded' : 'auto' };
    case 'adjust_daily_hard_limit':
      return { action, valid: true, tier: action.value > ctx.settings.dailyHardLimit ? 'guarded' : 'auto' };
    case 'adjust_max_crawls_per_day':
      return { action, valid: true, tier: action.value > ctx.settings.maxCrawlsPerDay ? 'guarded' : 'auto' };

    case 'adjust_minimum_publication_quality':
      // A *lower* bar publishes more, and more permissively -- loosening.
      return {
        action,
        valid: true,
        tier: action.value < ctx.settings.minimumPublicationQuality ? 'guarded' : 'auto',
      };

    case 'adjust_soft_ai_spend_cap':
      return { action, valid: true, tier: action.value > ctx.settings.softAiSpendGbpPerDay ? 'guarded' : 'auto' };
    case 'adjust_hard_ai_spend_cap':
      return { action, valid: true, tier: action.value > ctx.settings.hardAiSpendGbpPerDay ? 'guarded' : 'auto' };

    case 'create_campaign_draft':
      // A draft has zero effect on the live system until separately
      // activated (which is its own, guarded, set_campaign_status action).
      return { action, valid: true, tier: 'auto' };

    case 'set_campaign_status':
      return { action, valid: true, tier: action.value === 'running' ? 'guarded' : 'auto' };

    case 'adjust_campaign_daily_limits': {
      const campaign = ctx.campaigns.find(item => item.id === action.campaignId);
      if (!campaign) {
        return { action, valid: false, tier: 'guarded', invalidReason: 'campaign_not_found' };
      }
      const loosening =
        action.dailyTarget > campaign.dailyTarget || action.dailyHardLimit > campaign.dailyHardLimit;
      return { action, valid: true, tier: loosening ? 'guarded' : 'auto' };
    }

    default: {
      // The standard TS exhaustiveness idiom: this assignment only compiles
      // if every case above has narrowed `action` away, leaving it typed
      // `never` here. Adding a new kind to agentActionSchema without a
      // matching case above makes `action` something other than `never` in
      // this branch, which fails to type-check -- unlike a cast (e.g.
      // `action as { kind: string }`), which would silence exactly this
      // check and let an unclassified kind compile clean.
      const exhaustiveCheck: never = action;
      throw new Error(`Unclassified agent action kind: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
