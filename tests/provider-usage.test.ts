import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync('src/services/provider-usage.service.ts', 'utf8');

describe('provider search ceiling', () => {
  it('claims a search atomically, gated by the daily limit, rather than a non-atomic check-then-increment', () => {
    // Two concurrent discovery cycles for the same provider must not be able
    // to jointly issue more searches than dailyLimit allows -- the guard has
    // to be part of the same findOneAndUpdate that performs the increment,
    // like tryClaimDailyAcquisitionSlot and tryReserveDailyAiBudget already
    // do, not a separate read followed by a write.
    expect(source).toContain('findOneAndUpdate(');
    expect(source).toContain('searches: { $lt: limit }');
    expect(source).toContain('$inc: { searches: 1 }');
  });

  it('returns false rather than throwing once the daily limit is reached', () => {
    expect(source).toContain('return claimed !== null;');
  });
});

interface Doc {
  provider: string;
  day: string;
  searches: number;
  resultsSeen: number;
  estimatedCostGbp: number;
  updatedAt: string;
}

const store = new Map<string, Doc>();
const key = (provider: string, day: string) => `${provider}:${day}`;

// A minimal fake standing in for the one Mongo collection
// provider-usage.service.ts touches -- this repo has no live Mongo test
// harness, so this is what makes real behavioral coverage of the ledger
// possible at all (see tests/ai-budget.test.ts for the same pattern).
const fakeCollection = {
  updateOne: vi.fn(async (filter: { provider: string; day: string }, update: Record<string, unknown>) => {
    const k = key(filter.provider, filter.day);
    let doc = store.get(k);
    if (!doc) {
      doc = {
        provider: filter.provider,
        day: filter.day,
        searches: 0,
        resultsSeen: 0,
        estimatedCostGbp: 0,
        updatedAt: '',
        ...(update.$setOnInsert as Partial<Doc>),
      };
      store.set(k, doc);
    }
    const inc = update.$inc as Record<string, number> | undefined;
    if (inc) {
      for (const [field, amount] of Object.entries(inc)) {
        (doc as unknown as Record<string, number>)[field] += amount;
      }
    }
    return { acknowledged: true };
  }),
  findOne: vi.fn(async (filter: { provider: string; day: string }) => store.get(key(filter.provider, filter.day)) ?? null),
};

vi.mock('../src/lib/mongo.js', () => ({
  getDatabase: async () => ({ collection: () => fakeCollection }),
}));

const { getTodayProviderUsage, recordProviderUsage } = await import('../src/services/provider-usage.service.js');

describe('provider usage ledger (result volume)', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('accumulates resultsSeen across multiple record calls for the same day', async () => {
    // discovery.service.ts calls this once per query issued in a cycle, so
    // a campaign with several queries must have their result counts sum
    // rather than each call overwriting the last.
    await recordProviderUsage({ provider: 'brave', resultsSeen: 5 });
    await recordProviderUsage({ provider: 'brave', resultsSeen: 3 });
    expect((await getTodayProviderUsage('brave'))?.resultsSeen).toBe(8);
  });

  it('never touches searches or estimatedCostGbp', async () => {
    // searches is owned exclusively by tryClaimProviderSearch's atomic
    // claim -- recordProviderUsage double-incrementing it here would make
    // the daily search ceiling trip early. estimatedCostGbp stays at its
    // zero default because no provider adapter in this codebase has a
    // configured per-search price to derive a real figure from.
    await recordProviderUsage({ provider: 'brave', resultsSeen: 5 });
    const usage = await getTodayProviderUsage('brave');
    expect(usage?.searches).toBe(0);
    expect(usage?.estimatedCostGbp).toBe(0);
  });

  it('keeps a separate ledger per provider', async () => {
    await recordProviderUsage({ provider: 'brave', resultsSeen: 4 });
    await recordProviderUsage({ provider: 'other', resultsSeen: 9 });
    expect((await getTodayProviderUsage('brave'))?.resultsSeen).toBe(4);
    expect((await getTodayProviderUsage('other'))?.resultsSeen).toBe(9);
  });
});
