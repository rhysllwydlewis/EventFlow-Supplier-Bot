import type { AgentAction } from '../domain/agent-log.js';
import { createCampaign, updateCampaign } from '../repositories/campaign.repository.js';
import { clearEventFlowRetryBackoff } from '../repositories/eventflow-ingestion.repository.js';
import { emergencyStopBot, pauseBot, updateRuntimeSettings } from './runtime-control.service.js';

export const AGENT_ACTOR = 'ai-supervisor';

// Executes an action already classified 'auto' (or explicitly approved by an
// operator). Every branch is a thin call into the same functions the human
// Control Centre buttons and /api/settings route already use -- this file
// adds no new way to mutate the bot, it only decides which of the existing
// ways a given action maps to. Safety ceilings, the mode/publishing
// fail-safe, and audit logging all still apply exactly as they do for a
// human-driven request, because it's the same code underneath.
export async function applyAgentAction(action: AgentAction): Promise<string> {
  switch (action.kind) {
    case 'pause_bot':
      await pauseBot(AGENT_ACTOR);
      return 'Bot paused.';
    case 'emergency_stop_bot':
      await emergencyStopBot(AGENT_ACTOR);
      return 'Bot emergency-stopped.';
    case 'retry_stuck_publication': {
      const cleared = await clearEventFlowRetryBackoff(action.candidateId);
      return cleared
        ? `Retry backoff cleared for ${action.candidateId}; will retry on the next reconcile.`
        : `No failed/ineligible EventFlow ingestion found for ${action.candidateId}; nothing to retry.`;
    }
    case 'set_mode':
      await updateRuntimeSettings({ mode: action.value }, AGENT_ACTOR);
      return `Mode set to ${action.value}.`;
    case 'set_publishing_enabled':
      await updateRuntimeSettings({ publishingEnabled: action.value }, AGENT_ACTOR);
      return `Publishing ${action.value ? 'enabled' : 'disabled'}.`;
    case 'set_claim_notices_enabled':
      await updateRuntimeSettings({ claimNoticesEnabled: action.value }, AGENT_ACTOR);
      return `Claim notices ${action.value ? 'enabled' : 'disabled'}.`;
    case 'set_marketing_enabled':
      await updateRuntimeSettings({ marketingEnabled: action.value }, AGENT_ACTOR);
      return `Marketing ${action.value ? 'enabled' : 'disabled'}.`;
    case 'set_seo_indexing_enabled':
      await updateRuntimeSettings({ seoIndexingEnabled: action.value }, AGENT_ACTOR);
      return `SEO indexing ${action.value ? 'enabled' : 'disabled'}.`;
    case 'set_discovery_enabled':
      await updateRuntimeSettings({ discoveryEnabled: action.value }, AGENT_ACTOR);
      return `Discovery ${action.value ? 'enabled' : 'disabled'}.`;
    case 'set_refresh_enabled':
      await updateRuntimeSettings({ refreshEnabled: action.value }, AGENT_ACTOR);
      return `Refresh ${action.value ? 'enabled' : 'disabled'}.`;
    case 'adjust_daily_target':
      await updateRuntimeSettings({ dailyTarget: action.value }, AGENT_ACTOR);
      return `Daily target set to ${action.value}.`;
    case 'adjust_daily_hard_limit':
      await updateRuntimeSettings({ dailyHardLimit: action.value }, AGENT_ACTOR);
      return `Daily hard limit set to ${action.value}.`;
    case 'adjust_max_crawls_per_day':
      await updateRuntimeSettings({ maxCrawlsPerDay: action.value }, AGENT_ACTOR);
      return `Max crawls/day set to ${action.value}.`;
    case 'adjust_minimum_publication_quality':
      await updateRuntimeSettings({ minimumPublicationQuality: action.value }, AGENT_ACTOR);
      return `Minimum publication quality set to ${action.value}.`;
    case 'adjust_soft_ai_spend_cap':
      await updateRuntimeSettings({ softAiSpendGbpPerDay: action.value }, AGENT_ACTOR);
      return `Soft AI spend cap set to £${action.value}/day.`;
    case 'adjust_hard_ai_spend_cap':
      await updateRuntimeSettings({ hardAiSpendGbpPerDay: action.value }, AGENT_ACTOR);
      return `Hard AI spend cap set to £${action.value}/day.`;
    case 'create_campaign_draft': {
      const created = await createCampaign({
        name: action.name,
        categories: action.categories,
        locations: action.locations,
        dailyTarget: 0,
        dailyHardLimit: 1,
        minimumPublicationQuality: 85,
      });
      return `Draft campaign "${created.name}" created (${created.id}); stays a draft with zero live effect until an operator activates it.`;
    }
    case 'set_campaign_status':
      await updateCampaign(action.campaignId, { status: action.value });
      return `Campaign ${action.campaignId} set to ${action.value}.`;
    case 'adjust_campaign_daily_limits':
      await updateCampaign(action.campaignId, {
        dailyTarget: action.dailyTarget,
        dailyHardLimit: action.dailyHardLimit,
      });
      return `Campaign ${action.campaignId} daily limits set to ${action.dailyTarget}/${action.dailyHardLimit}.`;
  }
}
