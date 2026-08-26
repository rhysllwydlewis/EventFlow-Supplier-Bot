import type { Collection } from 'mongodb';
import { env } from '../config/env.js';
import { botSettingsSchema, defaultSettings, type BotSettings } from '../domain/settings.js';
import { getDatabase } from '../lib/mongo.js';

async function collection(): Promise<Collection<BotSettings>> {
  const db = await getDatabase();
  return db.collection<BotSettings>('bot_settings');
}

export async function getSettings(): Promise<BotSettings> {
  const store = await collection();
  const existing = await store.findOne({ id: 'global' });
  if (existing) {
    return botSettingsSchema.parse(existing);
  }

  const initial = defaultSettings();
  await store.updateOne({ id: 'global' }, { $setOnInsert: initial }, { upsert: true });
  return initial;
}

type MutableSettings = Pick<BotSettings,
  | 'mode'
  | 'runState'
  | 'discoveryEnabled'
  | 'publishingEnabled'
  | 'refreshEnabled'
  | 'claimNoticesEnabled'
  | 'marketingEnabled'
  | 'seoIndexingEnabled'
  | 'dailyTarget'
  | 'dailyHardLimit'
  | 'maxCrawlsPerDay'
  | 'minimumPublicationQuality'
  | 'softAiSpendGbpPerDay'
  | 'hardAiSpendGbpPerDay'
  | 'activeCampaignId'
>;

export type SettingsPatch = {
  [Key in keyof MutableSettings]?: MutableSettings[Key] | undefined;
};

function validateSafetyCeilings(candidate: BotSettings): void {
  if (candidate.dailyHardLimit > env.ABSOLUTE_MAX_PROFILES_PER_DAY) {
    throw new Error(`Daily hard limit exceeds absolute ceiling (${env.ABSOLUTE_MAX_PROFILES_PER_DAY})`);
  }
  if (candidate.maxCrawlsPerDay > env.ABSOLUTE_MAX_CRAWLS_PER_DAY) {
    throw new Error(`Crawl limit exceeds absolute ceiling (${env.ABSOLUTE_MAX_CRAWLS_PER_DAY})`);
  }
  if (candidate.hardAiSpendGbpPerDay > env.ABSOLUTE_MAX_AI_SPEND_GBP_PER_DAY) {
    throw new Error(`AI spend hard limit exceeds absolute ceiling (£${env.ABSOLUTE_MAX_AI_SPEND_GBP_PER_DAY})`);
  }
  if (candidate.dailyTarget > candidate.dailyHardLimit) {
    throw new Error('Daily target cannot exceed the daily hard limit');
  }
  if (candidate.softAiSpendGbpPerDay > candidate.hardAiSpendGbpPerDay) {
    throw new Error('Soft AI spend limit cannot exceed hard AI spend limit');
  }
  if (candidate.mode !== 'live' && candidate.publishingEnabled) {
    throw new Error('Publishing can only be enabled in live mode');
  }
}

export async function patchSettings(patch: SettingsPatch, actor: string): Promise<BotSettings> {
  const current = await getSettings();
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const candidate = botSettingsSchema.parse({
    ...current,
    ...definedPatch,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  });
  validateSafetyCeilings(candidate);

  const store = await collection();
  await store.replaceOne({ id: 'global' }, candidate, { upsert: true });
  return candidate;
}
