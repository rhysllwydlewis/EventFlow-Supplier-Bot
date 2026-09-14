import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MigrationDoc {
  id: string;
  completedAt: string;
}

interface FakeCandidate {
  id: string;
  canonicalDomain: string;
  canonicalUrl: string;
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
const setCandidateCanonicalUrl = vi.fn(async (id: string, canonicalUrl: string) => {
  const candidate = candidates.get(id);
  if (candidate) candidate.canonicalUrl = canonicalUrl;
});
const setCandidateStatus = vi.fn(async (id: string, status: string) => {
  const candidate = candidates.get(id);
  if (candidate) candidate.status = status;
});
vi.mock('../src/repositories/candidate.repository.js', () => ({
  getCandidateByCanonicalDomain,
  setCandidateCategoryHint,
  setCandidateCanonicalUrl,
  setCandidateStatus,
}));

const unpublishFromEventFlow = vi.fn();
vi.mock('../src/services/eventflow-unpublish.service.js', () => ({ unpublishFromEventFlow }));

const enqueueForcedCrawlCandidate = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/services/crawl-queue.service.js', () => ({ enqueueForcedCrawlCandidate }));

const { runLiveListingRemediation } = await import('../src/services/live-listing-remediation.service.js');

// Batch 1's two unpublish targets, batch 2's one -- three distinct
// supplierIds across the batches this file runs unconditionally.
const BATCH_1_UNPUBLISH_SUPPLIER_IDS = ['sup_bot_bce520ad8443f3d61efcec0f', 'sup_bot_b554aaff5429b7318128e9a8'];
const BATCH_2_UNPUBLISH_SUPPLIER_ID = 'sup_bot_190d1dbaf5d9a46b6779949f';

function seedCandidate(
  id: string,
  canonicalDomain: string,
  canonicalUrl = `https://${canonicalDomain}/some-wrong-subpage`,
  categoryHint: string | null = 'Venues',
) {
  candidates.set(id, { id, canonicalDomain, canonicalUrl, categoryHint, status: 'shadow_ready' });
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

  it('unpublishes all three listings that do not belong on the marketplace at all, across the batches', async () => {
    seedAllRecrawlCandidates();

    await runLiveListingRemediation();

    for (const supplierId of [...BATCH_1_UNPUBLISH_SUPPLIER_IDS, BATCH_2_UNPUBLISH_SUPPLIER_ID]) {
      expect(unpublishFromEventFlow).toHaveBeenCalledWith(expect.objectContaining({ supplierId }));
    }
    expect(unpublishFromEventFlow).toHaveBeenCalledTimes(3);
  });

  it('forces a recrawl for every recrawl target across all batches, bypassing the normal same-day dedup', async () => {
    // Real incident this guards against: an earlier version found all three
    // batch-1 recrawl targets already had a job under the ordinary day-
    // scoped/legacy jobId (organic crawl activity earlier the same day), so
    // going through enqueueCrawlCandidate's dedup silently queued nothing
    // for any of them. Events Made Simple is still a recrawl target in
    // batch 1's (already-ran) item list -- batch 2 unpublishing it
    // afterwards is redundant but harmless in a from-scratch environment
    // like this test; batch 1's list itself is kept as the historical
    // record of what actually ran. Faenol Fawr and Babs Boardwell are each
    // recrawled a second time in batch 3, with a corrected canonicalUrl.
    seedAllRecrawlCandidates();

    await runLiveListingRemediation();

    expect(candidates.get('candidate_faenol')?.status).toBe('queued_for_crawl');
    expect(candidates.get('candidate_events')?.status).toBe('queued_for_crawl');
    expect(candidates.get('candidate_babs')?.status).toBe('queued_for_crawl');
    expect(enqueueForcedCrawlCandidate).toHaveBeenCalledWith('candidate_faenol', 'live_listing_remediation');
    expect(enqueueForcedCrawlCandidate).toHaveBeenCalledWith('candidate_events', 'live_listing_remediation');
    expect(enqueueForcedCrawlCandidate).toHaveBeenCalledWith('candidate_babs', 'live_listing_remediation');
    // batch 1: Faenol, Events, Babs (3) -- batch 3: Faenol, Babs again (2)
    expect(enqueueForcedCrawlCandidate).toHaveBeenCalledTimes(5);
  });

  it('overrides the category hint only for the one candidate whose category was wrong', async () => {
    seedAllRecrawlCandidates();

    await runLiveListingRemediation();

    expect(candidates.get('candidate_babs')?.categoryHint).toBe('Photography');
    expect(candidates.get('candidate_faenol')?.categoryHint).toBe('Venues');
  });

  it('corrects the crawl entry point (canonicalUrl) for the two candidates batch 3 targets', async () => {
    // Real bug this closes: batch 1's forced recrawl re-crawled from each
    // candidate's existing (wrong) canonicalUrl -- a deep subpage for Faenol
    // Fawr, Babs Boardwell's own roundup blog post for Babs Boardwell -- so
    // it never actually reached either business's homepage, and therefore
    // never reliably found the real photos/pricing living one click from it.
    seedAllRecrawlCandidates();

    await runLiveListingRemediation();

    expect(candidates.get('candidate_faenol')?.canonicalUrl).toBe('https://faenolfawrhotel.co.uk/');
    expect(candidates.get('candidate_babs')?.canonicalUrl).toBe('https://www.babsboardwellweddings.co.uk/');
    // Events Made Simple is never a batch-3 target (it was unpublished in
    // batch 2), so its canonicalUrl is left exactly as seeded.
    expect(candidates.get('candidate_events')?.canonicalUrl).toBe('https://eventsmadesimple.co.uk/some-wrong-subpage');
  });

  it('is idempotent: a second run does nothing once every batchs migration record exists', async () => {
    seedAllRecrawlCandidates();

    await runLiveListingRemediation();
    unpublishFromEventFlow.mockClear();
    enqueueForcedCrawlCandidate.mockClear();
    setCandidateCanonicalUrl.mockClear();

    await runLiveListingRemediation();

    expect(unpublishFromEventFlow).not.toHaveBeenCalled();
    expect(enqueueForcedCrawlCandidate).not.toHaveBeenCalled();
    expect(setCandidateCanonicalUrl).not.toHaveBeenCalled();
  });

  it('does not record completion for a batch, and retries it on the next call, when an unpublish call fails non-terminally', async () => {
    // Simulates the real deploy-ordering risk every unpublish-bearing batch
    // runs under: this repo's PR can ship before rhysllwydlewis/EventFlow#1666
    // (the endpoint it calls) is deployed, so the first attempt may fail
    // with 'failed' or 'not_configured' rather than a terminal outcome.
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

  it('skips a recrawl target whose candidate is not found, without failing the rest of that batch or the other batches', async () => {
    // Only seed Babs Boardwell -- Faenol Fawr's candidate is missing (so
    // both batch 1 and batch 3 skip it), and batch 2's unpublish target
    // doesn't depend on a local candidate at all.
    seedCandidate('candidate_babs', 'babsboardwellweddings.co.uk');

    await runLiveListingRemediation();

    expect(unpublishFromEventFlow).toHaveBeenCalledTimes(3);
    // batch 1: Babs (1) -- batch 3: Babs again (1)
    expect(enqueueForcedCrawlCandidate).toHaveBeenCalledTimes(2);
    expect(auditEvents.some(event => event.action === 'remediation.candidate_not_found')).toBe(true);
  });
});
