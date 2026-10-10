import { createHash } from 'node:crypto';
import type { AgentAction, AgentActionRecord } from '../domain/agent-log.js';
import type { BotSettings } from '../domain/settings.js';
import type { Campaign } from '../domain/campaign.js';
import { classifyAgentAction } from '../services/agent-ruleset.service.js';

// The operator's approval policy, as code. Same principle as
// agent-ruleset.service.ts: the decision about what may be approved without a
// human is made here, deterministically, and never by a model reading the
// recommendation text. The control service still re-validates every approval
// server-side; this layer only decides whether the operator should *ask*.
//
// Three outcomes per pending recommendation:
//   approve  - on the narrow allowlist below and every precondition holds
//   dismiss  - wrong, moot, superseded or stale (the supervisor re-proposes
//              anything still relevant on its next cycle, and the full action
//              payload is kept in the run log, so nothing is lost)
//   escalate - a real decision that belongs to the owner; never actioned here

export type OperatorDecision = 'approve' | 'dismiss' | 'escalate';

export type PolicyRule =
  | 'invalid'
  | 'no_longer_loosening'
  | 'superseded'
  | 'stale'
  | 'allowlisted'
  | 'allowlist_precondition_failed'
  | 'owner_only'
  | 'owner_decision';

export interface PolicyVerdict {
  id: string;
  kind: AgentAction['kind'];
  decision: OperatorDecision;
  rule: PolicyRule;
  reason: string;
  // Human-readable one-liner of what the action would change right now.
  summary: string;
  // Stable across runs for the same underlying request, so the owner is only
  // notified about a given decision once (plus a periodic reminder).
  fingerprint: string;
  createdAt: string;
  action: AgentAction;
}

export interface PolicyContext {
  now: number;
  settings: BotSettings;
  campaigns: Campaign[];
  // Pending items older than this are dismissed as stale.
  staleAfterHours: number;
}

export const DEFAULT_STALE_AFTER_HOURS = 24 * 7;

// Kinds the operator must never approve, however fresh and however it is
// worded. They are the "less cautious" moves the Shadow-first design keeps
// behind a human: going live, anything outward-facing, money, and the quality
// bar. (The classifier would mark most of them guarded anyway; this list makes
// the operator's refusal independent of that, so a future change to the
// ruleset can never silently widen what the operator is willing to approve.)
function isOwnerOnly(action: AgentAction, settings: BotSettings): string | null {
  switch (action.kind) {
    case 'set_mode':
      return action.value === 'live' ? 'going live' : null;
    case 'set_publishing_enabled':
      return action.value ? 'enabling publishing' : null;
    case 'set_claim_notices_enabled':
      return action.value ? 'enabling claim notices' : null;
    case 'set_marketing_enabled':
      return action.value ? 'enabling marketing' : null;
    case 'set_seo_indexing_enabled':
      return action.value ? 'enabling SEO indexing' : null;
    case 'adjust_soft_ai_spend_cap':
      return action.value > settings.softAiSpendGbpPerDay ? 'raising the soft AI spend cap' : null;
    case 'adjust_hard_ai_spend_cap':
      return action.value > settings.hardAiSpendGbpPerDay ? 'raising the hard AI spend cap' : null;
    case 'adjust_minimum_publication_quality':
      return action.value < settings.minimumPublicationQuality ? 'lowering the publication quality bar' : null;
    case 'set_campaign_status':
      return action.value === 'running' ? 'activating a campaign' : null;
    default:
      return null;
  }
}

// The allowlist: low-risk loosening that stays inside the Phase 3 safety
// contract. Deliberately tiny; extend it here, with a test, not in a prompt.
// Preconditions mirror the contract in docs/PHASE3_SAFETY.md: not live, and
// every outward-facing control off.
function allowlistVerdict(action: AgentAction, settings: BotSettings): { ok: boolean; why: string } | null {
  if (action.kind !== 'set_discovery_enabled' && action.kind !== 'set_refresh_enabled') return null;
  if (!action.value) return null;
  const outwardOff = !settings.publishingEnabled && !settings.marketingEnabled && !settings.seoIndexingEnabled;
  const notLive = settings.mode === 'shadow' || settings.mode === 'dry_run';
  if (notLive && outwardOff) {
    return { ok: true, why: `safe while mode=${settings.mode} with publishing, marketing and SEO indexing all off` };
  }
  return {
    ok: false,
    why: `only auto-approved while mode is shadow/dry_run with all outward-facing controls off (mode=${settings.mode}, publishing=${settings.publishingEnabled}, marketing=${settings.marketingEnabled}, seoIndexing=${settings.seoIndexingEnabled})`,
  };
}

function supersedeKey(action: AgentAction): string {
  const campaignId = 'campaignId' in action ? action.campaignId : '';
  return `${action.kind}:${campaignId}`;
}

function fingerprintOf(action: AgentAction): string {
  const { reason: _reason, ...rest } = action as AgentAction & { reason?: string };
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function diffList(next: string[], current: string[]): string {
  const added = next.filter(item => !current.includes(item));
  const removed = current.filter(item => !next.includes(item));
  const parts: string[] = [];
  if (added.length) parts.push(`+${added.join(', +')}`);
  if (removed.length) parts.push(`-${removed.join(', -')}`);
  return parts.length ? parts.join(' ') : 'no change';
}

export function summariseAction(action: AgentAction, ctx: Pick<PolicyContext, 'settings' | 'campaigns'>): string {
  const { settings, campaigns } = ctx;
  switch (action.kind) {
    case 'adjust_campaign_scope': {
      const campaign = campaigns.find(item => item.id === action.campaignId);
      if (!campaign) return `change scope of unknown campaign ${action.campaignId}`;
      return `${campaign.name} scope: categories ${diffList(action.categories, campaign.categories)}; locations ${diffList(action.locations, campaign.locations)}`;
    }
    case 'adjust_campaign_daily_limits': {
      const campaign = campaigns.find(item => item.id === action.campaignId);
      const name = campaign?.name ?? action.campaignId;
      const from = campaign ? `${campaign.dailyTarget}/${campaign.dailyHardLimit}` : '?';
      return `${name} daily target/hard limit ${from} -> ${action.dailyTarget}/${action.dailyHardLimit}`;
    }
    case 'set_mode':
      return `mode ${settings.mode} -> ${action.value}`;
    case 'adjust_daily_target':
      return `daily target ${settings.dailyTarget} -> ${action.value}`;
    case 'adjust_daily_hard_limit':
      return `daily hard limit ${settings.dailyHardLimit} -> ${action.value}`;
    case 'adjust_max_crawls_per_day':
      return `max crawls/day ${settings.maxCrawlsPerDay} -> ${action.value}`;
    case 'adjust_minimum_publication_quality':
      return `minimum publication quality ${settings.minimumPublicationQuality} -> ${action.value}`;
    case 'adjust_soft_ai_spend_cap':
      return `soft AI spend cap £${settings.softAiSpendGbpPerDay} -> £${action.value}/day`;
    case 'adjust_hard_ai_spend_cap':
      return `hard AI spend cap £${settings.hardAiSpendGbpPerDay} -> £${action.value}/day`;
    case 'set_campaign_status':
      return `campaign ${action.campaignId} -> ${action.value}`;
    case 'create_campaign_draft':
      return `create draft campaign "${action.name}"`;
    case 'retry_stuck_publication':
      return `retry stuck publication ${action.candidateId}`;
    case 'pause_bot':
    case 'emergency_stop_bot':
      return action.kind.replace(/_/g, ' ');
    default:
      return `${action.kind} -> ${String(action.value)}`;
  }
}

export function decideRecommendations(items: AgentActionRecord[], ctx: PolicyContext): PolicyVerdict[] {
  const pending = items.filter(item => item.status === 'pending_approval');

  // Newest pending item per (kind, campaign): older ones are superseded. A
  // plateaued campaign makes the supervisor re-propose a slightly different
  // scope every cycle; applying more than one of them would just overwrite
  // each other, and only the latest reflects its current view.
  const newest = new Map<string, string>();
  for (const item of [...pending].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const key = supersedeKey(item.action);
    if (!newest.has(key)) newest.set(key, item.id);
  }

  const staleBefore = ctx.now - ctx.staleAfterHours * 3_600_000;

  return pending.map((item): PolicyVerdict => {
    const base = {
      id: item.id,
      kind: item.action.kind,
      createdAt: item.createdAt,
      action: item.action,
      summary: summariseAction(item.action, ctx),
      fingerprint: fingerprintOf(item.action),
    };
    const verdict = (decision: OperatorDecision, rule: PolicyRule, reason: string): PolicyVerdict => ({
      ...base,
      decision,
      rule,
      reason,
    });

    const classified = classifyAgentAction(item.action, { settings: ctx.settings, campaigns: ctx.campaigns });
    if (!classified.valid) {
      return verdict('dismiss', 'invalid', `no longer valid: ${classified.invalidReason ?? 'unknown'}`);
    }
    if (classified.tier === 'auto') {
      return verdict('dismiss', 'no_longer_loosening', 'now a no-op or a safety-direction change against current state');
    }
    if (newest.get(supersedeKey(item.action)) !== item.id) {
      return verdict('dismiss', 'superseded', 'a newer pending recommendation of the same kind exists for the same target');
    }
    const createdMs = Date.parse(item.createdAt);
    if (Number.isFinite(createdMs) && createdMs < staleBefore) {
      return verdict('dismiss', 'stale', `pending for more than ${ctx.staleAfterHours}h; the supervisor re-proposes if still relevant`);
    }

    const ownerOnly = isOwnerOnly(item.action, ctx.settings);
    if (ownerOnly) {
      return verdict('escalate', 'owner_only', `${ownerOnly} is never approved by the operator`);
    }

    const allow = allowlistVerdict(item.action, ctx.settings);
    if (allow?.ok) return verdict('approve', 'allowlisted', allow.why);
    if (allow && !allow.ok) return verdict('escalate', 'allowlist_precondition_failed', allow.why);

    return verdict('escalate', 'owner_decision', 'loosening change outside the operator allowlist');
  });
}
