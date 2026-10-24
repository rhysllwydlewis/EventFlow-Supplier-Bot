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

// searches is already incremented atomically by tryClaimProviderSearch (the
// budget-claim path) -- this only adds the result-volume side of the ledger,
// which has no ceiling of its own and so doesn't need the same atomic claim.
// estimatedCostGbp is deliberately left untouched here: unlike the OpenAI
// usage ledger (ai-usage.service.ts), no provider adapter in this codebase
// has a configured per-search price to derive it from, so it stays at its
// $setOnInsert default of 0 rather than reporting a fabricated cost.
export async function recordProviderUsage(input: { provider: string; resultsSeen: number }): Promise<void> {
  const day = utcDay();
  const db = await getDatabase();
  await db.collection<ProviderUsage>('provider_usage').updateOne(
    { provider: input.provider, day },
    {
      $inc: { resultsSeen: Math.max(0, Math.floor(input.resultsSeen)) },
      $set: { updatedAt: new Date().toISOString() },
      $setOnInsert: { provider: input.provider, day, searches: 0, estimatedCostGbp: 0 },
    },
    { upsert: true },
  );
}

export async function getTodayProviderUsage(provider: string): Promise<ProviderUsage | null> {
  const db = await getDatabase();
  return db.collection<ProviderUsage>('provider_usage').findOne({ provider, day: utcDay() });
}
