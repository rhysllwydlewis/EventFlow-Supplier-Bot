import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../src/config/env.js';

vi.mock('../src/config/env.js', async importOriginal => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    env: {
      ...actual.env,
      OPENAI_CIRCUIT_FAILURE_THRESHOLD: 3,
      OPENAI_CIRCUIT_OPEN_MINUTES: 15,
    },
  };
});

interface Doc {
  id: string;
  consecutiveFailures: number;
  openUntil: string | null;
  updatedAt: string;
}

const store = new Map<string, Doc>();

const fakeCollection = {
  updateOne: vi.fn(async (filter: { id: string }, update: Record<string, unknown>, opts?: { upsert?: boolean }) => {
    let doc = store.get(filter.id);
    if (!doc) {
      if (!opts?.upsert) return { acknowledged: true };
      doc = {
        id: filter.id,
        consecutiveFailures: 0,
        openUntil: null,
        updatedAt: '',
        ...(update.$setOnInsert as Partial<Doc> | undefined),
      };
      store.set(filter.id, doc);
    }
    if (update.$inc) {
      const inc = update.$inc as Record<string, number>;
      if (inc.consecutiveFailures) doc.consecutiveFailures += inc.consecutiveFailures;
    }
    if (update.$set) {
      Object.assign(doc, update.$set);
    }
    return { acknowledged: true };
  }),
  findOne: vi.fn(async (filter: { id: string }) => store.get(filter.id) ?? null),
};

vi.mock('../src/lib/mongo.js', () => ({
  getDatabase: async () => ({ collection: () => fakeCollection }),
}));

const { openAiCircuitAllowsRequest, recordOpenAiFailure, recordOpenAiSuccess } = await import(
  '../src/services/ai-circuit.service.js'
);

describe('OpenAI provider circuit breaker', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('allows requests when no circuit record exists yet', async () => {
    expect(await openAiCircuitAllowsRequest()).toBe(true);
  });

  it('keeps allowing requests below the failure threshold', async () => {
    await recordOpenAiFailure();
    await recordOpenAiFailure();
    expect(await openAiCircuitAllowsRequest()).toBe(true);
  });

  it('opens the circuit once consecutive failures reach the threshold, blocking further requests', async () => {
    await recordOpenAiFailure();
    await recordOpenAiFailure();
    await recordOpenAiFailure();
    expect(await openAiCircuitAllowsRequest()).toBe(false);
  });

  it('closes again automatically once openUntil has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    await recordOpenAiFailure();
    await recordOpenAiFailure();
    await recordOpenAiFailure();
    expect(await openAiCircuitAllowsRequest()).toBe(false);

    vi.setSystemTime(new Date('2026-09-18T00:16:00.000Z'));
    expect(await openAiCircuitAllowsRequest()).toBe(true);
    vi.useRealTimers();
  });

  it('a success resets the failure count and clears an open circuit', async () => {
    await recordOpenAiFailure();
    await recordOpenAiFailure();
    await recordOpenAiFailure();
    expect(await openAiCircuitAllowsRequest()).toBe(false);

    await recordOpenAiSuccess();
    expect(await openAiCircuitAllowsRequest()).toBe(true);

    // Confirms the reset actually zeroed consecutiveFailures rather than
    // merely clearing openUntil -- two more failures alone must not reopen
    // the circuit (threshold is 3).
    await recordOpenAiFailure();
    await recordOpenAiFailure();
    expect(await openAiCircuitAllowsRequest()).toBe(true);
  });
});
