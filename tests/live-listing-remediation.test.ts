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

const enqueueCrawlCandidate = vi.fn().mockResolvedValue(true);
vi.mock('../src/services/crawl-queue.service.js', () => ({ enqueueCrawlCandidate }));

const { runLiveListingRemediation } = await import('../src/services/live-listing-remediation.service.js');

function seedCandidate(id: string, canonicalDomain: string, categoryHint: string | null = 'Venues') {
  candidates.set(id, { id, canonicalDomain, categoryHint, status: 'shadow_ready' });
}

describe('live listing remediation (one-off startup migration)', () => {
  beforeEach(() => {
    candidates.clear();
    migrations.clear();
    auditEvents.length = 0;
    vi.clearAllMocks();
    unpublishFromEventFlow.mockResolvedValue({ status: 'unpublished' });
    enqueueCrawlCandidate.mockResolvedValue(true);
  });

  it('unpublishes the two listings that do not belong on the marketplace at all', async () => {
    seedCandidate('candidate_faenol', 'faenolfawrhotel.co.uk');
    seedCandidate('candidate_events', 'eventsmadesimple.co.uk');
    seedCandidate('candidate_babs', 'babsboardwellweddings.co.uk');

    await runLiveListingRemediation();

    expect(unpublishFromEventFlow).toHaveBeenCalledWith(
      expect.objectContaining({ supplierId: 'sup_bot_bce520ad8443f3d61efcec0f' }),
    );
    expect(unpublishFromEventFlow).toHaveBeenCalledWith(
      expect.objectContaining({ supplierId: 'sup_bot_b554aaff5429b7318128e9a8' }),
    );
    expect(unpublishFromEventFlow).toHaveBeenCalledTimes(2);
  });

  it('forces a recrawl for the three genuine businesses with fixable data', async () => {
    seedCandidate('candidate_faenol', 'faenolfawrhotel.co.uk');
    seedCandidate('candidate_events', 'eventsmadesimple.co.uk');
    seedCandidate('candidate_babs', 'babsboardwellweddings.co.uk');

    await runLiveListingRemediation();

    expect(candidates.get('candidate_faenol')?.status).toBe('queued_for_crawl');
    expect(candidates.get('candidate_events')?.status).toBe('queued_for_crawl');
    expect(candidates.get('candidate_babs')?.status).toBe('queued_for_crawl');
    expect(enqueueCrawlCandidate).toHaveBeenCalledWith('candidate_faenol', 'live_listing_remediation');
    expect(enqueueCrawlCandidate).toHaveBeenCalledWith('candidate_events', 'live_listing_remediation');
    expect(enqueueCrawlCandidate).toHaveBeenCalledWith('candidate_babs', 'live_listing_remediation');
  });

  it('overrides the category hint only for the one candidate whose category was wrong', async () => {
    seedCandidate('candidate_faenol', 'faenolfawrhotel.co.uk', 'Venues');
    seedCandidate('candidate_events', 'eventsmadesimple.co.uk', 'Venues');
    seedCandidate('candidate_babs', 'babsboardwellweddings.co.uk', 'Venues');

    await runLiveListingRemediation();

    expect(candidates.get('candidate_babs')?.categoryHint).toBe('Photography');
    expect(candidates.get('candidate_faenol')?.categoryHint).toBe('Venues');
    expect(candidates.get('candidate_events')?.categoryHint).toBe('Venues');
  });

  it('is idempotent: a second run does nothing once the migration record exists', async () => {
    seedCandidate('candidate_faenol', 'faenolfawrhotel.co.uk');
    seedCandidate('candidate_events', 'eventsmadesimple.co.uk');
    seedCandidate('candidate_babs', 'babsboardwellweddings.co.uk');

    await runLiveListingRemediation();
    unpublishFromEventFlow.mockClear();
    enqueueCrawlCandidate.mockClear();

    await runLiveListingRemediation();

    expect(unpublishFromEventFlow).not.toHaveBeenCalled();
    expect(enqueueCrawlCandidate).not.toHaveBeenCalled();
  });

  it('skips a recrawl target whose candidate is not found, without failing the whole batch', async () => {
    // Only seed two of the three recrawl candidates -- the third (and both
    // unpublish targets, which don't depend on a local candidate at all)
    // must still be processed.
    seedCandidate('candidate_faenol', 'faenolfawrhotel.co.uk');
    seedCandidate('candidate_babs', 'babsboardwellweddings.co.uk');

    await runLiveListingRemediation();

    expect(unpublishFromEventFlow).toHaveBeenCalledTimes(2);
    expect(enqueueCrawlCandidate).toHaveBeenCalledTimes(2);
    expect(auditEvents.some(event => event.action === 'remediation.candidate_not_found')).toBe(true);
  });
});
