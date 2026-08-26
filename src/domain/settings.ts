import { z } from 'zod';

export const operatingModeSchema = z.enum(['off', 'dry_run', 'shadow', 'live']);
export const runStateSchema = z.enum(['stopped', 'running', 'paused', 'draining', 'emergency_stopped']);

export const botSettingsSchema = z.object({
  id: z.literal('global'),
  mode: operatingModeSchema,
  runState: runStateSchema,
  discoveryEnabled: z.boolean(),
  publishingEnabled: z.boolean(),
  refreshEnabled: z.boolean(),
  claimNoticesEnabled: z.boolean(),
  marketingEnabled: z.boolean(),
  seoIndexingEnabled: z.boolean(),
  dailyTarget: z.number().int().min(0),
  dailyHardLimit: z.number().int().min(0),
  maxCrawlsPerDay: z.number().int().min(0),
  minimumPublicationQuality: z.number().min(0).max(100),
  softAiSpendGbpPerDay: z.number().min(0),
  hardAiSpendGbpPerDay: z.number().min(0),
  activeCampaignId: z.string().nullable(),
  updatedAt: z.string(),
  updatedBy: z.string(),
});

export type OperatingMode = z.infer<typeof operatingModeSchema>;
export type RunState = z.infer<typeof runStateSchema>;
export type BotSettings = z.infer<typeof botSettingsSchema>;

export const defaultSettings = (): BotSettings => ({
  id: 'global',
  mode: 'shadow',
  runState: 'stopped',
  discoveryEnabled: true,
  publishingEnabled: false,
  refreshEnabled: true,
  claimNoticesEnabled: false,
  marketingEnabled: false,
  seoIndexingEnabled: false,
  dailyTarget: 10,
  dailyHardLimit: 10,
  maxCrawlsPerDay: 100,
  minimumPublicationQuality: 85,
  softAiSpendGbpPerDay: 5,
  hardAiSpendGbpPerDay: 10,
  activeCampaignId: null,
  updatedAt: new Date().toISOString(),
  updatedBy: 'system-default',
});
