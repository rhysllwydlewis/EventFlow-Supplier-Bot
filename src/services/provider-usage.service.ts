import { getDatabase } from '../lib/mongo.js';

export interface ProviderUsage {
  provider: string;
  day: string;
  searches: number;
  resultsSeen: number;
  estimatedCostGbp: number;
  updatedAt: string;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

// The candidate-acquisition ceiling (acquisition-budget.service.ts) bounds
// how many candidates get *created* per day, but a search is issued once per
// campaign/category/location query regardless of whether any result from it
// survives quality filtering, suppression or dedup -- so without this, a
// campaign with many query combinations could keep issuing provider search
// calls indefinitely even on a day where the acquisition ceiling is already
// exhausted. This is the absolute ceiling on that: an atomic claim (findOneAndUpdate
// with $lt/$inc as a single operation, like tryClaimDailyAcquisitionSlot and
// tryReserveDailyAiBudget) so concurrent discovery cycles can't jointly issue
// more searches than dailyLimit allows.
export async function tryClaimProviderSearch(provider: string, dailyLimit: number): Promise<boolean> {
  const limit = Math.max(0, Math.floor(dailyLimit));
  if (limit === 0) return false;

  const day = utcDay();
  const db = await getDatabase();
  const store = db.collection<ProviderUsage>('provider_usage');
  await store.updateOne(
    { provider, day },
    {
      $setOnInsert: {
        provider,
        day,
        searches: 0,
        resultsSeen: 0,
        estimatedCostGbp: 0,
        updatedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );

  const claimed = await store.findOneAndUpdate(
    { provider, day, searches: { $lt: limit } },
    { $inc: { searches: 1 }, $set: { updatedAt: new Date().toISOString() } },
    { returnDocument: 'after' },
  );
  return claimed !== null;
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
