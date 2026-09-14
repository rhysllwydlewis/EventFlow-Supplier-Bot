import { z } from 'zod';
import { operatingModeSchema } from './settings.js';

// The complete vocabulary of actions the AI supervisor may ever propose.
// This is a closed list on purpose: the strict OpenAI json_schema response
// format can only ever emit one of these shapes, and agent-ruleset.service.ts
// only ever recognises these kinds -- anything else (a hallucinated action, a
// future model deciding to invent a "hard_reset" kind) is structurally
// impossible to emit, and even if it were, classifyAgentAction() rejects any
// kind it doesn't explicitly list rather than defaulting it to allowed.
// 'resume_bot' is deliberately absent: bringing an idle-but-ready bot back
// up is handled as deterministic pre-AI self-healing (agent-supervisor.
// service.ts), not left to depend on the model noticing it.
export const agentActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pause_bot'), reason: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('emergency_stop_bot'), reason: z.string().min(1).max(300) }),
  z.object({
    kind: z.literal('retry_stuck_publication'),
    candidateId: z.string().min(1).max(200),
    reason: z.string().min(1).max(300),
  }),
  z.object({ kind: z.literal('set_mode'), value: operatingModeSchema, reason: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('set_publishing_enabled'), value: z.boolean(), reason: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('set_claim_notices_enabled'), value: z.boolean(), reason: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('set_marketing_enabled'), value: z.boolean(), reason: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('set_seo_indexing_enabled'), value: z.boolean(), reason: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('set_discovery_enabled'), value: z.boolean(), reason: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('set_refresh_enabled'), value: z.boolean(), reason: z.string().min(1).max(300) }),
  z.object({
    kind: z.literal('adjust_daily_target'),
    value: z.number().int().min(0).max(1000),
    reason: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal('adjust_daily_hard_limit'),
    value: z.number().int().min(0).max(1000),
    reason: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal('adjust_max_crawls_per_day'),
    value: z.number().int().min(0).max(5000),
    reason: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal('adjust_minimum_publication_quality'),
    value: z.number().min(0).max(100),
    reason: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal('adjust_soft_ai_spend_cap'),
    value: z.number().min(0).max(50),
    reason: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal('adjust_hard_ai_spend_cap'),
    value: z.number().min(0).max(50),
    reason: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal('create_campaign_draft'),
    name: z.string().min(1).max(120),
    categories: z.array(z.string().min(1).max(60)).min(1).max(5),
    locations: z.array(z.string().min(1).max(60)).min(1).max(5),
    reason: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal('set_campaign_status'),
    campaignId: z.string().min(1).max(200),
    value: z.enum(['running', 'paused', 'archived']),
    reason: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal('adjust_campaign_daily_limits'),
    campaignId: z.string().min(1).max(200),
    dailyTarget: z.number().int().min(0).max(1000),
    dailyHardLimit: z.number().int().min(1).max(1000),
    reason: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal('adjust_campaign_scope'),
    campaignId: z.string().min(1).max(200),
    categories: z.array(z.string().min(1).max(60)).min(1).max(10),
    locations: z.array(z.string().min(1).max(60)).min(1).max(10),
    reason: z.string().min(1).max(300),
  }),
]);
export type AgentAction = z.infer<typeof agentActionSchema>;

export const agentCycleResponseSchema = z.object({
  findings: z.array(z.string().min(1).max(400)).max(10),
  diary: z.string().min(1).max(2000),
  actions: z.array(agentActionSchema).max(10),
});

export const agentActionTierSchema = z.enum(['auto', 'guarded']);
export type AgentActionTier = z.infer<typeof agentActionTierSchema>;

export const agentActionStatusSchema = z.enum([
  'applied',
  'pending_approval',
  'approved',
  'dismissed',
  'rejected_invalid',
  'failed',
]);
export type AgentActionStatus = z.infer<typeof agentActionStatusSchema>;

export interface AgentActionRecord {
  id: string;
  logEntryId: string;
  createdAt: string;
  action: AgentAction;
  tier: AgentActionTier;
  status: AgentActionStatus;
  invalidReason?: string | null;
  decidedAt?: string | null;
  decidedBy?: string | null;
  resultDetail?: string | null;
}

export type AgentCycleKind = 'self_heal_only' | 'ai_cycle' | 'ai_skipped';

export interface AgentLogEntry {
  id: string;
  createdAt: string;
  trigger: 'scheduler' | 'manual';
  kind: AgentCycleKind;
  skippedReason?: string | null;
  selfHealNotes: string[];
  findings: string[];
  diary: string;
  model: string | null;
  actionIds: string[];
}
