import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Doc {
  candidateId: string;
  status: string;
  supplierId: string | null;
  slug: string | null;
  publicProfilePath: string | null;
  reason: string | null;
  attempts: number;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const store = new Map<string, Doc>();

// A minimal fake standing in for the one Mongo collection
// eventflow-ingestion.repository.ts touches -- this repo has no live Mongo
// test harness, so this is what makes real behavioral coverage of the
// upsert semantics possible at all (a source-string assertion can't prove
// $set vs $setOnInsert vs $inc actually behave the way the code intends).
const fakeCollection = {
  updateOne: vi.fn(
    async (
      filter: { candidateId: string },
      update: { $set?: Partial<Doc>; $setOnInsert?: Partial<Doc>; $inc?: { attempts?: number } },
    ) => {
      const existing = store.get(filter.candidateId);
      if (!existing) {
        const created: Doc = {
          candidateId: filter.candidateId,
          status: 'pending',
          supplierId: null,
          slug: null,
          publicProfilePath: null,
          reason: null,
          attempts: 0,
          nextRetryAt: null,
          createdAt: '',
          updatedAt: '',
          ...update.$setOnInsert,
          ...update.$set,
        };
        if (update.$inc?.attempts) created.attempts = (created.attempts || 0) + update.$inc.attempts;
        store.set(filter.candidateId, created);
        return { acknowledged: true, upsertedCount: 1 };
      }
      Object.assign(existing, update.$set);
      if (update.$inc?.attempts) existing.attempts += update.$inc.attempts;
      return { acknowledged: true, upsertedCount: 0 };
    },
  ),
  findOne: vi.fn(async (filter: { candidateId: string }) => store.get(filter.candidateId) ?? null),
};

vi.mock('../src/lib/mongo.js', () => ({
  getDatabase: async () => ({ collection: () => fakeCollection }),
}));

const { getEventFlowIngestion, saveEventFlowIngestionState } = await import(
  '../src/repositories/eventflow-ingestion.repository.js'
);

describe('eventflow_ingestions attempts counter', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('increments attempts across consecutive incrementing saves', async () => {
    await saveEventFlowIngestionState({
      candidateId: 'c1',
      status: 'ineligible',
      reason: 'compliance_block',
      incrementAttempts: true,
      nextRetryAt: '2026-01-01T00:00:30.000Z',
    });
    expect((await getEventFlowIngestion('c1'))?.attempts).toBe(1);

    await saveEventFlowIngestionState({
      candidateId: 'c1',
      status: 'ineligible',
      reason: 'compliance_block',
      incrementAttempts: true,
      nextRetryAt: '2026-01-01T00:01:00.000Z',
    });
    expect((await getEventFlowIngestion('c1'))?.attempts).toBe(2);
  });

  it('resets attempts to 0 when a non-incrementing save follows -- a fresh episode, not a continuation', async () => {
    // Without this, a candidate that cycles through e.g. ineligible (backed
    // off, attempts climbing) -> pending (a fresh crawl resets it) ->
    // ineligible again would keep accumulating attempts across those
    // unrelated episodes, backing off faster each time even though each
    // occurrence is really a fresh one.
    await saveEventFlowIngestionState({
      candidateId: 'c1',
      status: 'ineligible',
      reason: 'compliance_block',
      incrementAttempts: true,
      nextRetryAt: '2026-01-01T00:00:30.000Z',
    });
    await saveEventFlowIngestionState({
      candidateId: 'c1',
      status: 'ineligible',
      reason: 'compliance_block',
      incrementAttempts: true,
      nextRetryAt: '2026-01-01T00:01:00.000Z',
    });
    expect((await getEventFlowIngestion('c1'))?.attempts).toBe(2);

    // A fresh crawl completes and marks it 'pending' again
    // (markEventFlowPublicationPending, eventflow-publication-queue.service.ts)
    // -- not incrementing, so this is a new episode.
    await saveEventFlowIngestionState({ candidateId: 'c1', status: 'pending', reason: 'shadow_profile_ready' });
    expect((await getEventFlowIngestion('c1'))?.attempts).toBe(0);

    // The next ineligible mark starts counting from 0, not 2.
    await saveEventFlowIngestionState({
      candidateId: 'c1',
      status: 'ineligible',
      reason: 'compliance_block',
      incrementAttempts: true,
      nextRetryAt: '2026-01-01T00:00:30.000Z',
    });
    expect((await getEventFlowIngestion('c1'))?.attempts).toBe(1);
  });

  it('starts a brand new candidate at 0 attempts, whether its first save increments or not', async () => {
    await saveEventFlowIngestionState({ candidateId: 'fresh-pending', status: 'pending', reason: 'shadow_profile_ready' });
    expect((await getEventFlowIngestion('fresh-pending'))?.attempts).toBe(0);

    await saveEventFlowIngestionState({
      candidateId: 'fresh-ineligible',
      status: 'ineligible',
      reason: 'known_non_supplier_domain',
      incrementAttempts: true,
      nextRetryAt: '2026-01-01T00:00:30.000Z',
    });
    expect((await getEventFlowIngestion('fresh-ineligible'))?.attempts).toBe(1);
  });

  it('clears nextRetryAt on a non-backed-off save (a successful publish, or a fresh pending mark)', async () => {
    await saveEventFlowIngestionState({
      candidateId: 'c1',
      status: 'ineligible',
      reason: 'compliance_block',
      incrementAttempts: true,
      nextRetryAt: '2026-01-01T00:00:30.000Z',
    });
    expect((await getEventFlowIngestion('c1'))?.nextRetryAt).toBe('2026-01-01T00:00:30.000Z');

    await saveEventFlowIngestionState({
      candidateId: 'c1',
      status: 'created',
      supplierId: 'sup_1',
      slug: 'example-supplier',
      publicProfilePath: '/supplier/example-supplier--0123456789abcdef',
    });
    expect((await getEventFlowIngestion('c1'))?.nextRetryAt).toBeNull();
    expect((await getEventFlowIngestion('c1'))?.status).toBe('created');
  });
});
