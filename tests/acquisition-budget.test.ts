import { beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const store = new Map<string, Doc>();

function getPath(obj: Doc, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Doc)[k]), obj);
}

function setPath(obj: Doc, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Doc = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    if (cur[k] == null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function incPath(obj: Doc, path: string, amount: number): void {
  const current = (getPath(obj, path) as number | undefined) ?? 0;
  setPath(obj, path, current + amount);
}

// Unrecognized operators fail the match (closed) rather than being ignored
// (open) -- a filter shape this fake doesn't understand must never be
// silently treated as "no constraint", or a test could pass vacuously
// against a source mutation that changes the operator.
function matchesFilter(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const actual = getPath(doc, key);
      for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
        if (op === '$lt') {
          if (!((actual as number) < (opVal as number))) return false;
        } else if (op === '$gt') {
          if (!((actual as number) > (opVal as number))) return false;
        } else if (op === '$exists') {
          const exists = actual !== undefined;
          if (exists !== opVal) return false;
        } else {
          return false;
        }
      }
    } else if (getPath(doc, key) !== value) {
      return false;
    }
  }
  return true;
}

// A minimal fake standing in for the one Mongo collection
// acquisition-budget.service.ts touches -- unlike the simpler daily
// counters, this one also nests a per-campaign count under a dot path
// (campaignCounts.<hash>), so the fake needs dot-path get/set/inc, not
// just top-level fields, to exercise the real atomicity behavior.
const fakeCollection = {
  updateOne: vi.fn(async (filter: { id: string }, update: Record<string, unknown>, opts?: { upsert?: boolean }) => {
    let doc = store.get(filter.id);
    if (!doc) {
      if (opts?.upsert && update.$setOnInsert) {
        doc = { ...(update.$setOnInsert as Doc) };
        store.set(filter.id, doc);
      }
      return { acknowledged: true };
    }
    if (!matchesFilter(doc, filter)) return { acknowledged: true };
    if (update.$set) {
      for (const [k, v] of Object.entries(update.$set as Doc)) setPath(doc, k, v);
    }
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc as Doc)) incPath(doc, k, v as number);
    }
    return { acknowledged: true };
  }),
  findOneAndUpdate: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
    const doc = store.get(filter.id as string);
    if (!doc || !matchesFilter(doc, filter)) return null;
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc as Doc)) incPath(doc, k, v as number);
    }
    if (update.$set) {
      for (const [k, v] of Object.entries(update.$set as Doc)) setPath(doc, k, v);
    }
    return doc;
  }),
  findOne: vi.fn(async (filter: { id: string }) => store.get(filter.id) ?? null),
};

vi.mock('../src/lib/mongo.js', () => ({
  getDatabase: async () => ({ collection: () => fakeCollection }),
}));

const { releaseDailyAcquisitionSlot, tryClaimDailyAcquisitionSlot } = await import(
  '../src/services/acquisition-budget.service.js'
);

async function readCounter(day: string): Promise<Doc | null> {
  const db = await (await import('../src/lib/mongo.js')).getDatabase();
  return db.collection('runtime_counters').findOne({ id: `acquisition:${day}` });
}

describe('daily acquisition-slot claim', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('claims a slot atomically, gated by both the per-campaign and global limits', async () => {
    const day = '2026-09-18';
    expect(await tryClaimDailyAcquisitionSlot('campaign-a', 5, 10, day)).toBe(true);
    const doc = await readCounter(day);
    expect(doc?.globalCount).toBe(1);
  });

  it('refuses once a campaign hits its own limit, even though the global limit has room', async () => {
    const day = '2026-09-18';
    for (let i = 0; i < 2; i += 1) {
      expect(await tryClaimDailyAcquisitionSlot('campaign-a', 2, 100, day)).toBe(true);
    }
    expect(await tryClaimDailyAcquisitionSlot('campaign-a', 2, 100, day)).toBe(false);
    const doc = await readCounter(day);
    expect(doc?.globalCount).toBe(2);
  });

  it('refuses once the global limit is hit, even for a campaign under its own limit', async () => {
    const day = '2026-09-18';
    expect(await tryClaimDailyAcquisitionSlot('campaign-a', 100, 1, day)).toBe(true);
    expect(await tryClaimDailyAcquisitionSlot('campaign-b', 100, 1, day)).toBe(false);
  });

  it('tracks separate campaigns under independent counters sharing one global count', async () => {
    const day = '2026-09-18';
    expect(await tryClaimDailyAcquisitionSlot('campaign-a', 5, 10, day)).toBe(true);
    expect(await tryClaimDailyAcquisitionSlot('campaign-b', 5, 10, day)).toBe(true);
    const doc = await readCounter(day);
    expect(doc?.globalCount).toBe(2);
    const counts = Object.values(doc?.campaignCounts ?? {}) as number[];
    expect(counts.sort()).toEqual([1, 1]);
  });

  it('refuses every claim once either limit is zero', async () => {
    const day = '2026-09-18';
    expect(await tryClaimDailyAcquisitionSlot('campaign-a', 0, 10, day)).toBe(false);
    expect(await tryClaimDailyAcquisitionSlot('campaign-a', 10, 0, day)).toBe(false);
  });

  it('release decrements both the claiming campaign and the global count, and is claimable again', async () => {
    const day = '2026-09-18';
    expect(await tryClaimDailyAcquisitionSlot('campaign-a', 1, 1, day)).toBe(true);
    expect(await tryClaimDailyAcquisitionSlot('campaign-a', 1, 1, day)).toBe(false);

    await releaseDailyAcquisitionSlot('campaign-a', day);
    const doc = await readCounter(day);
    expect(doc?.globalCount).toBe(0);

    expect(await tryClaimDailyAcquisitionSlot('campaign-a', 1, 1, day)).toBe(true);
  });

  it('a double release (a retried call, or a caller bug) never pushes a counter negative or bypasses the ceiling', async () => {
    // Without a floor, releasing the same slot twice would let globalCount
    // (and the campaign's own count) go negative -- widening how many
    // claims the $lt ceiling check then allows through, defeating the
    // ceiling it exists to enforce.
    const day = '2026-09-18';
    expect(await tryClaimDailyAcquisitionSlot('campaign-a', 1, 1, day)).toBe(true);

    await releaseDailyAcquisitionSlot('campaign-a', day);
    await releaseDailyAcquisitionSlot('campaign-a', day);

    const doc = await readCounter(day);
    expect(doc?.globalCount).toBe(0);
    const campaignCounts = Object.values(doc?.campaignCounts ?? {}) as number[];
    expect(campaignCounts.every(count => count === 0)).toBe(true);

    // The ceiling still holds: only the one legitimately-freed slot is
    // claimable, not two.
    expect(await tryClaimDailyAcquisitionSlot('campaign-a', 1, 1, day)).toBe(true);
    expect(await tryClaimDailyAcquisitionSlot('campaign-a', 1, 1, day)).toBe(false);
  });

  it('releases against the day the slot was actually claimed on, not "today" recomputed later', async () => {
    // Same reasoning as ai-budget.test.ts's equivalent test: a slot claimed
    // just before UTC midnight and released just after must decrement the
    // *same* day's document, not a different (likely nonexistent, so
    // silently no-op) day's counter.
    const claimDay = '2026-08-27';
    const laterDay = '2026-08-28';
    expect(await tryClaimDailyAcquisitionSlot('campaign-a', 1, 1, claimDay)).toBe(true);

    await releaseDailyAcquisitionSlot('campaign-a', claimDay);

    expect((await readCounter(claimDay))?.globalCount).toBe(0);
    expect(await readCounter(laterDay)).toBeNull();
  });
});
