import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Doc {
  id: string;
  day: string;
  amountGbp: number;
  updatedAt: string;
}

const store = new Map<string, Doc>();

function matchesFilter(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'amountGbp' && value && typeof value === 'object' && '$lte' in (value as Record<string, unknown>)) {
      if (!(doc.amountGbp <= (value as { $lte: number }).$lte)) return false;
      continue;
    }
    if (doc[key as keyof Doc] !== value) return false;
  }
  return true;
}

// A minimal fake standing in for the one Mongo collection ai-budget.service.ts
// touches -- this repo has no live Mongo test harness, so this is what makes
// real behavioral coverage of the claim/release atomicity possible at all.
const fakeCollection = {
  updateOne: vi.fn(async (filter: { id: string }, update: Record<string, unknown>) => {
    const existing = store.get(filter.id);
    if (!existing) {
      const setOnInsert = (update.$setOnInsert as Doc | undefined) ?? {
        id: filter.id,
        day: '',
        amountGbp: 0,
        updatedAt: '',
      };
      store.set(filter.id, { ...setOnInsert });
      return { acknowledged: true };
    }
    const inc = update.$inc as Record<string, number> | undefined;
    if (inc?.amountGbp) existing.amountGbp += inc.amountGbp;
    return { acknowledged: true };
  }),
  findOneAndUpdate: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
    const doc = store.get(filter.id as string);
    if (!doc || !matchesFilter(doc, filter)) return null;
    const inc = update.$inc as Record<string, number> | undefined;
    if (inc?.amountGbp) doc.amountGbp += inc.amountGbp;
    return doc;
  }),
  findOne: vi.fn(async (filter: { id: string }) => store.get(filter.id) ?? null),
};

vi.mock('../src/lib/mongo.js', () => ({
  getDatabase: async () => ({ collection: () => fakeCollection }),
}));

const { currentUtcDay, getTodayAiReservedGbp, releaseDailyAiBudget, tryReserveDailyAiBudget } =
  await import('../src/services/ai-budget.service.js');

describe('AI daily budget reservation and release', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('claims a reservation atomically, gated by the effective limit', async () => {
    const day = currentUtcDay();
    const claimed = await tryReserveDailyAiBudget(1, 10, 0.1, day);
    expect(claimed).toBe(true);
    expect(await getTodayAiReservedGbp()).toBeCloseTo(0.1);
  });

  it('refuses a reservation once the effective (configured vs. absolute) limit is exhausted', async () => {
    const day = currentUtcDay();
    for (let i = 0; i < 10; i += 1) {
      expect(await tryReserveDailyAiBudget(1, 10, 0.1, day)).toBe(true);
    }
    expect(await tryReserveDailyAiBudget(1, 10, 0.1, day)).toBe(false);
    expect(await getTodayAiReservedGbp()).toBeCloseTo(1);
  });

  it('releases a reservation on call failure so the ledger does not drift for a call that never spent anything', async () => {
    // Without a release path, a call that reserves budget and then fails
    // (network error, API error, timeout) permanently eats its reservation
    // even though no money was actually spent -- the budget ledger drifts
    // further from the actual-cost ledger with every failure.
    const day = currentUtcDay();
    await tryReserveDailyAiBudget(1, 10, 0.1, day);
    expect(await getTodayAiReservedGbp()).toBeCloseTo(0.1);

    await releaseDailyAiBudget(0.1, day);
    expect(await getTodayAiReservedGbp()).toBeCloseTo(0);

    // The released budget is claimable again by a subsequent call.
    expect(await tryReserveDailyAiBudget(1, 10, 0.1, day)).toBe(true);
  });

  it('releases against the day the reservation was actually made on, not "today" recomputed later', async () => {
    // A reservation claimed just before UTC midnight and released just
    // after must decrement the *same* day's document -- recomputing "today"
    // independently at release time would silently decrement a different
    // (very likely nonexistent, so silently no-op) day's counter instead.
    const reservationDay = '2026-08-27';
    const laterDay = '2026-08-28';
    await tryReserveDailyAiBudget(1, 10, 0.1, reservationDay);

    await releaseDailyAiBudget(0.1, reservationDay);

    const db = await (await import('../src/lib/mongo.js')).getDatabase();
    const collection = db.collection('runtime_counters');
    expect((await collection.findOne({ id: `ai-budget:${reservationDay}` }))?.amountGbp).toBeCloseTo(0);
    expect(await collection.findOne({ id: `ai-budget:${laterDay}` })).toBeNull();
  });
});
