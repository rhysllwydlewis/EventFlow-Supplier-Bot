import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Doc {
  id: string;
  day: string;
  count: number;
  updatedAt: string;
}

const store = new Map<string, Doc>();

function matchesFilter(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'count' && value && typeof value === 'object' && '$lt' in (value as Record<string, unknown>)) {
      if (!(doc.count < (value as { $lt: number }).$lt)) return false;
      continue;
    }
    if (doc[key as keyof Doc] !== value) return false;
  }
  return true;
}

// A minimal fake standing in for the one Mongo collection
// browser-crawl-budget.service.ts touches. Mirrors tests/ai-budget.test.ts's fake.
const fakeCollection = {
  updateOne: vi.fn(async (filter: { id: string }, update: Record<string, unknown>) => {
    const existing = store.get(filter.id);
    if (!existing) {
      const setOnInsert = (update.$setOnInsert as Doc | undefined) ?? {
        id: filter.id,
        day: '',
        count: 0,
        updatedAt: '',
      };
      store.set(filter.id, { ...setOnInsert });
    }
    return { acknowledged: true };
  }),
  findOneAndUpdate: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
    const doc = store.get(filter.id as string);
    if (!doc || !matchesFilter(doc, filter)) return null;
    const inc = update.$inc as Record<string, number> | undefined;
    if (inc?.count) doc.count += inc.count;
    return doc;
  }),
  findOne: vi.fn(async (filter: { id: string }) => store.get(filter.id) ?? null),
};

vi.mock('../src/lib/mongo.js', () => ({
  getDatabase: async () => ({ collection: () => fakeCollection }),
}));

const { getTodayBrowserCrawlCount, tryClaimDailyBrowserCrawlSlot } = await import(
  '../src/services/browser-crawl-budget.service.js'
);

describe('daily browser-crawl-slot claim', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('claims a slot atomically up to the absolute limit', async () => {
    expect(await tryClaimDailyBrowserCrawlSlot(2)).toBe(true);
    expect(await tryClaimDailyBrowserCrawlSlot(2)).toBe(true);
    expect(await getTodayBrowserCrawlCount()).toBe(2);
  });

  it('refuses a claim once the absolute limit is exhausted', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(await tryClaimDailyBrowserCrawlSlot(3)).toBe(true);
    }
    expect(await tryClaimDailyBrowserCrawlSlot(3)).toBe(false);
    expect(await getTodayBrowserCrawlCount()).toBe(3);
  });

  it('refuses every claim once the limit is zero or negative', async () => {
    expect(await tryClaimDailyBrowserCrawlSlot(0)).toBe(false);
    expect(await tryClaimDailyBrowserCrawlSlot(-1)).toBe(false);
    expect(await getTodayBrowserCrawlCount()).toBe(0);
  });
});
