import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Doc {
  provider: string;
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostGbp: number;
  updatedAt: string;
}

const store = new Map<string, Doc>();
const key = (provider: string, day: string) => `${provider}:${day}`;

// A minimal fake standing in for the one Mongo collection ai-usage.service.ts
// touches -- same pattern as tests/ai-budget.test.ts and
// tests/provider-usage.test.ts.
const fakeCollection = {
  updateOne: vi.fn(async (filter: { provider: string; day: string }, update: Record<string, unknown>) => {
    const k = key(filter.provider, filter.day);
    let doc = store.get(k);
    if (!doc) {
      doc = {
        provider: filter.provider,
        day: filter.day,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
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

const { getTodayAiUsage, recordAiUsage } = await import('../src/services/ai-usage.service.js');

describe('AI usage ledger (calls/tokens/cost)', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('accumulates calls, tokens and cost across multiple record calls for the same day', async () => {
    await recordAiUsage({ inputTokens: 100, outputTokens: 50, estimatedCostGbp: 0.02 });
    await recordAiUsage({ inputTokens: 200, outputTokens: 80, estimatedCostGbp: 0.03 });
    const usage = await getTodayAiUsage();
    expect(usage?.calls).toBe(2);
    expect(usage?.inputTokens).toBe(300);
    expect(usage?.outputTokens).toBe(130);
    expect(usage?.estimatedCostGbp).toBeCloseTo(0.05);
  });

  it('floors and clamps negative token counts to zero rather than corrupting the running total', async () => {
    // A caller passing a negative or fractional token count (a bug upstream,
    // or a provider response with an unexpected shape) must not be able to
    // push the ledger's running total below what was actually recorded.
    await recordAiUsage({ inputTokens: -5, outputTokens: 12.9, estimatedCostGbp: -1 });
    const usage = await getTodayAiUsage();
    expect(usage?.inputTokens).toBe(0);
    expect(usage?.outputTokens).toBe(12);
    expect(usage?.estimatedCostGbp).toBe(0);
  });

  it('returns null for a day with no recorded usage', async () => {
    expect(await getTodayAiUsage()).toBeNull();
  });
});
