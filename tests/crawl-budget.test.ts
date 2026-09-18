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

// A minimal fake standing in for the one Mongo collection crawl-budget.service.ts
// touches -- this repo has no live Mongo test harness, so this is what makes
// real behavioral coverage of the claim atomicity possible at all. Mirrors
// tests/ai-budget.test.ts's fake.
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

const { getTodayCrawlCount, tryClaimDailyCrawlSlot } = await import('../src/services/crawl-budget.service.js');

describe('daily crawl-slot claim', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('claims a slot atomically up to the effective (configured vs. absolute) limit', async () => {
    expect(await tryClaimDailyCrawlSlot(2, 10)).toBe(true);
    expect(await tryClaimDailyCrawlSlot(2, 10)).toBe(true);
    expect(await getTodayCrawlCount()).toBe(2);
  });

  it('refuses a claim once the effective limit is exhausted', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(await tryClaimDailyCrawlSlot(3, 10)).toBe(true);
    }
    expect(await tryClaimDailyCrawlSlot(3, 10)).toBe(false);
    expect(await getTodayCrawlCount()).toBe(3);
  });

  it('takes the lower of configured and absolute limits, never the higher', async () => {
    // absoluteLimit is the hard safety ceiling -- a misconfigured (too high)
    // configuredLimit must never be able to bypass it.
    for (let i = 0; i < 2; i += 1) {
      expect(await tryClaimDailyCrawlSlot(100, 2)).toBe(true);
    }
    expect(await tryClaimDailyCrawlSlot(100, 2)).toBe(false);
  });

  it('refuses every claim once the effective limit is zero', async () => {
    expect(await tryClaimDailyCrawlSlot(0, 10)).toBe(false);
    expect(await tryClaimDailyCrawlSlot(10, 0)).toBe(false);
    expect(await getTodayCrawlCount()).toBe(0);
  });
});
