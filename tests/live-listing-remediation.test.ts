import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MigrationDoc {
  id: string;
  completedAt: string;
}

interface FakeCandidate {
  id: string;
  canonicalDomain: string;
  categoryHint: string | null;
  status: string;
}

const migrations = new Map<string, MigrationDoc>();
const candidates = new Map<string, FakeCandidate>();
const auditEvents: Array<{ actor: string; action: string; details: Record<string, unknown> }> = [];

const migrationCollection = {
  findOne: vi.fn(async (filter: { id: string }) => migrations.get(filter.id) ?? null),
  updateOne: vi.fn(async (filter: { id: string }, update: { $set: MigrationDoc }) => {
    migrations.set(filter.id, update.$set);
    return { acknowledged: true };
  }),
};

vi.mock('../src/lib/mongo.js', () => ({
  getDatabase: async () => ({
    collection: (name: string) => {
      if (name === 'maintenance_migrations') return migrationCollection;
      throw new Error(`Unexpected collection: ${name}`);
    },
  }),
}));

vi.mock('../src/repositories/audit.repository.js', () => ({
  recordAuditEvent: vi.fn(async (actor: string, action: string, details: Record<string, unknown> = {}) => {
    auditEvents.push({ actor, action, details });
  }),
}));

const getCandidateByCanonicalDomain = vi.fn(async (domain: string) => {
  const normalized = domain.toLowerCase();
  return [...candidates.values()].find(c => c.canonicalDomain === normalized) ?? null;
});
const setCandidateCategoryHint = vi.fn(async (id: string, categoryHint: string) => {
  const candidate = candidates.get(id);
  if (candidate) candidate.categoryHint = categoryHint;
});
const setCandidateStatus = vi.fn(async (id: string, status: string) => {
  const candidate = candidates.get(id);
  if (candidate) candidate.status = status;
});
vi.mock('../src/repositories/candidate.repository.js', () => ({
  getCandidateByCanonicalDomain,
  setCandidateCategoryHint,
  setCandidateStatus,
}));

const unpublishFromEventFlow = vi.fn();
vi.mock('../src/services/eventflow-unpublish.service.js', () => ({ unpublishFromEventFlow }));

const enqueueForcedCrawlCandidate = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/services/crawl-queue.service.js', () => ({ enqueueForcedCrawlCandidate }));

const { runLiveListingRemediation } = await import('../src/services/live-listing-remediation.service.js');

// Batch 1's two unpublish targets, batch 2's one -- three distinct
// supplierIds across the two batches this file runs unconditionally.
const BATCH_1_UNPUBLISH_SUPPLIER_IDS = ['sup_bot_bce520ad8443f3d61efcec0f', 'sup_bot_b554aaff5429b7318128e9a8'];
const BATCH_2_UNPUBLISH_SUPPLIER_ID = 'sup_bot_190d1dbaf5d9a46b6779949f';

function seedCandidate(id: string, canonicalDomain: string, categoryHint: string | null = 'Venues') {
  candidates.set(id, { id, canonicalDomain, categoryHint, status: 'shadow_ready' });
}

function seedAllRecrawlCandidates() {
  seedCandidate('candidate_faenol', 'faenolfawrhotel.co.uk');
  seedCandidate('candidate_events', 'eventsmadesimple.co.uk');
  seedCandidate('candidate_babs', 'babsboardwellweddings.co.uk');
}

describe('live listing remediation (one-off startup migrations, run as separate batches)', () => {
  beforeEach(() => {
    candidates.clear();
    migrations.clear();
    auditEvents.length = 0;
    vi.clearAllMocks();
    unpublishFromEventFlow.mockResolvedValue({ status: 'unpublished' });
    enqueueForcedCrawlCandidate.mockResolvedValue(undefined);
  });

  it('unpublishes all three listings that do not belong on the marketplace at all, across both batches', async () => {
    seedAllRecrawlCandidates();

    await runLiveListingRemediation();

    for (const supplierId of [...BATCH_1_UNPUBLISH_SUPPLIER_IDS, BATCH_2_UNPUBLISH_SUPPLIER_ID]) {
      expect(unpublishFromEventFlow).toHaveBeenCalledWith(expect.objectContaining({ supplierId }));
    }
    expect(unpublishFromEventFlow).toHaveBeenCalledTimes(3);
  });

  it('forces a recrawl for batch 1s three targets, bypassing the normal same-day dedup', async () => {
    // Real incident this guards against: an earlier version found all three
    // recrawl targets already had a job under the ordinary day-scoped/legacy
    // jobId (organic crawl activity earlier the same day), so going through
    // enqueueCrawlCandidate's dedup silently queued nothing for any of them.
    // Events Made Simple is still a recrawl target in batch 1's (already-ran)
    // item list -- batch 2 unpublishing it afterwards (operator-confirmed
    // it's a directory-style platform, not a genuine supplier) is redundant
    // but harmless in a from-scratch environment like this test; batch 1's
    // list itself is kept as the historical record of what actually ran.
    seedAllRecrawlCandidates();

    await runLiveListingRemediation();

    expect(candidates.get('candidate_faenol')?.status).toBe('queued_for_crawl');
    expect(candidates.get('candidate_events')?.status).toBe('queued_for_crawl');
    expect(candidates.get('candidate_babs')?.status).toBe('queued_for_crawl');
    expect(enqueueForcedCrawlCandidate).toHaveBeenCalledWith('candidate_faenol', 'live_listing_remediation');
    expect(enqueueForcedCrawlCandidate).toHaveBeenCalledWith('candidate_events', 'live_listing_remediation');
    expect(enqueueForcedCrawlCandidate).toHaveBeenCalledWith('candidate_babs', 'live_listing_remediation');
    expect(enqueueForcedCrawlCandidate).toHaveBeenCalledTimes(3);
  });

  it('overrides the category hint only for the one candidate whose category was wrong', async () => {
    seedAllRecrawlCandidates();

    await runLiveListingRemediation();

    expect(candidates.get('candidate_babs')?.categoryHint).toBe('Photography');
    expect(candidates.get('candidate_faenol')?.categoryHint).toBe('Venues');
  });

  it('is idempotent: a second run does nothing once both migration records exist', async () => {
    seedAllRecrawlCandidates();

    await runLiveListingRemediation();
    unpublishFromEventFlow.mockClear();
    enqueueForcedCrawlCandidate.mockClear();

    await runLiveListingRemediation();

    expect(unpublishFromEventFlow).not.toHaveBeenCalled();
    expect(enqueueForcedCrawlCandidate).not.toHaveBeenCalled();
  });

  it('does not record completion for a batch, and retries it on the next call, when an unpublish call fails non-terminally', async () => {
    // Simulates the real deploy-ordering risk both batches run under: this
    // repo's PR can ship before rhysllwydlewis/EventFlow#1666 (the endpoint
    // it calls) is deployed, so the first attempt may fail with 'failed' or
    // 'not_configured' rather than a terminal outcome.
    seedAllRecrawlCandidates();
    unpublishFromEventFlow.mockResolvedValue({ status: 'failed', reason: 'eventflow_http_404' });

    await runLiveListingRemediation();
    unpublishFromEventFlow.mockClear();
    enqueueForcedCrawlCandidate.mockClear();
    unpublishFromEventFlow.mockResolvedValue({ status: 'unpublished' });

    await runLiveListingRemediation();

    expect(unpublishFromEventFlow).toHaveBeenCalledTimes(3);
  });

  it('does not record completion, and retries, on a 404 not_found -- indistinguishable from the endpoint not being deployed yet', async () => {
    // Real incident, not a hypothetical: an earlier deployed run got exactly
    // this for both batch-1 unpublish targets, because EventFlow's own PR
    // (#1666) was still mid-deploy when that attempt ran -- a plain Express
    // 404 for the not-yet-existing route reports identically to a genuinely
    // unknown supplier id.
    seedAllRecrawlCandidates();
    unpublishFromEventFlow.mockResolvedValue({ status: 'not_found', reason: 'eventflow_supplier_not_found' });

    await runLiveListingRemediation();
    unpublishFromEventFlow.mockClear();
    unpublishFromEventFlow.mockResolvedValue({ status: 'unpublished' });

    await runLiveListingRemediation();

    expect(unpublishFromEventFlow).toHaveBeenCalledTimes(3);
  });

  it('skips a recrawl target whose candidate is not found, without failing the rest of that batch or the other batch', async () => {
    // Only seed Babs Boardwell -- Faenol Fawr's candidate is missing, and
    // batch 2's unpublish target doesn't depend on a local candidate at all.
    seedCandidate('candidate_babs', 'babsboardwellweddings.co.uk');

    await runLiveListingRemediation();

    expect(unpublishFromEventFlow).toHaveBeenCalledTimes(3);
    expect(enqueueForcedCrawlCandidate).toHaveBeenCalledTimes(1);
    expect(auditEvents.some(event => event.action === 'remediation.candidate_not_found')).toBe(true);
  });
});
