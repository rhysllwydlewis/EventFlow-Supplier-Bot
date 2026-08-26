import { getDatabase } from '../lib/mongo.js';

export interface ProviderUsage {
  provider: string;
  day: string;
  searches: number;
  resultsSeen: number;
  estimatedCostGbp: number;
  updatedAt: string;
}

export async function recordProviderUsage(input: Omit<ProviderUsage, 'updatedAt'>): Promise<void> {
  const db = await getDatabase();
  await db.collection<ProviderUsage>('provider_usage').updateOne(
    { provider: input.provider, day: input.day },
    {
      $inc: {
        searches: input.searches,
        resultsSeen: input.resultsSeen,
        estimatedCostGbp: input.estimatedCostGbp,
      },
      $set: { updatedAt: new Date().toISOString() },
      $setOnInsert: { provider: input.provider, day: input.day },
    },
    { upsert: true },
  );
}

export async function getTodayProviderUsage(provider: string): Promise<ProviderUsage | null> {
  const day = new Date().toISOString().slice(0, 10);
  const db = await getDatabase();
  return db.collection<ProviderUsage>('provider_usage').findOne({ provider, day });
}
