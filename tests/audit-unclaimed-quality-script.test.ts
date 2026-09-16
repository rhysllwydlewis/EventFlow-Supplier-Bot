import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotSettings } from '../src/domain/settings.js';
import type { ShadowProfile } from '../src/domain/shadow-profile.js';
import type { AuditQueueItem } from '../src/services/eventflow-quality-audit.service.js';

const crawlSupplierSite = vi.fn();
vi.mock('../src/crawler/site-crawler.js', () => ({ crawlSupplierSite }));

const getShadowProfile = vi.fn();
const saveShadowProfile = vi.fn();
vi.mock('../src/repositories/shadow-profile.repository.js', () => ({ getShadowProfile, saveShadowProfile }));

const getSettings = vi.fn();
vi.mock('../src/repositories/settings.repository.js', () => ({ getSettings }));

const getTodayCrawlCount = vi.fn();
const tryClaimDailyCrawlSlot = vi.fn();
vi.mock('../src/services/crawl-budget.service.js', () => ({ getTodayCrawlCount, tryClaimDailyCrawlSlot }));

const fetchAuditQueue = vi.fn();
const refreshEventFlowSupplierData = vi.fn();
vi.mock('../src/services/eventflow-quality-audit.service.js', () => ({ fetchAuditQueue, refreshEventFlowSupplierData }));

const recordAuditEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/repositories/audit.repository.js', () => ({ recordAuditEvent }));

const { auditOneSupplier, activeGapNames, main } = await import('../src/scripts/audit-unclaimed-quality.js');

function settingsFixture(overrides: Partial<BotSettings> = {}): BotSettings {
  return {
    id: 'global',
    mode: 'shadow',
    runState: 'running',
    discoveryEnabled: true,
    publishingEnabled: true,
    refreshEnabled: true,
    claimNoticesEnabled: false,
    marketingEnabled: false,
    seoIndexingEnabled: false,
    dailyTarget: 10,
    dailyHardLimit: 10,
    maxCrawlsPerDay: 100,
    minimumPublicationQuality: 85,
    softAiSpendGbpPerDay: 5,
    hardAiSpendGbpPerDay: 10,
    activeCampaignId: null,
    updatedAt: new Date().toISOString(),
    updatedBy: 'test',
    ...overrides,
  };
}

function queueItem(overrides: Partial<AuditQueueItem> = {}): AuditQueueItem {
  return {
    supplierId: 'sup_bot_1',
    candidateId: 'candidate_1',
    website: 'https://example-venue.test/',
    slug: 'example-venue',
    name: 'Example Venue',
    publicationScope: 'public_unclaimed',
    publishedUnclaimedAt: '2026-09-01T00:00:00.000Z',
    completenessScore: 50,
    gaps: {
      missingCoverImage: false,
      missingGalleryImages: false,
      missingDescription: false,
      missingPhone: false,
      missingTags: false,
      packagesMissingPhotos: [],
    },
    ...overrides,
  };
}

function shadowProfileFixture(overrides: Partial<ShadowProfile> = {}): ShadowProfile {
  return {
    candidateId: 'candidate_1',
    businessName: 'Example Venue',
    category: 'Venues',
    location: 'Cardiff',
    website: 'https://example-venue.test/',
    description: 'x'.repeat(10),
    publicEmail: null,
    publicPhone: null,
    advertisedPrices: [],
    services: [],
    packages: [],
    evidenceIds: [],
    profileImage: null,
    profileImageEvidence: null,
    coverImage: null,
    images: [],
    mediaEvidence: [],
    dataConfidence: 40,
    publicationQuality: 40,
    generatedAt: new Date().toISOString(),
    generatorVersion: 'deterministic-shadow-profile-image-v3',
    ...overrides,
  };
}

function crawlResultWithMedia(): unknown {
  return {
    rootUrl: 'https://example-venue.test/',
    finalRootUrl: 'https://example-venue.test/',
    pages: [
      {
        url: 'https://example-venue.test/',
        contentType: 'text/html',
        html: '<html><body><a href="tel:02920000000">Call</a><img src="https://example-venue.test/hero.jpg"></body></html>',
        bytes: 100,
      },
    ],
    failures: [],
  };
}

describe('activeGapNames', () => {
  it('lists only the gaps that are actually flagged', () => {
    const names = activeGapNames({
      missingCoverImage: true,
      missingGalleryImages: false,
      missingDescription: false,
      missingPhone: true,
      missingTags: false,
      packagesMissingPhotos: [{ id: 'pkg_1', title: 'Day package' }],
    });
    expect(names).toEqual(['missingCoverImage', 'missingPhone', 'packagesMissingPhotos(1)']);
  });
});

describe('auditOneSupplier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips a queue item with no candidateId rather than guessing', async () => {
    const result = await auditOneSupplier(queueItem({ candidateId: null }), settingsFixture());
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('audit_queue_item_missing_candidate_id');
    expect(getShadowProfile).not.toHaveBeenCalled();
  });

  it('skips when this candidate has no locally stored shadow profile to safely refresh from', async () => {
    getShadowProfile.mockResolvedValue(null);

    const result = await auditOneSupplier(queueItem(), settingsFixture());

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('no_local_shadow_profile_for_candidate');
    expect(tryClaimDailyCrawlSlot).not.toHaveBeenCalled();
  });

  it('skips without recrawling when the daily crawl budget has no slot left', async () => {
    getShadowProfile.mockResolvedValue(shadowProfileFixture());
    tryClaimDailyCrawlSlot.mockResolvedValue(false);

    const result = await auditOneSupplier(queueItem(), settingsFixture());

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('daily_crawl_budget_exhausted');
    expect(crawlSupplierSite).not.toHaveBeenCalled();
  });

  it('skips and records why when the recrawl itself fails', async () => {
    getShadowProfile.mockResolvedValue(shadowProfileFixture());
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockRejectedValue(new Error('Crawler blocked by robots.txt for requested supplier URL'));

    const result = await auditOneSupplier(queueItem({ gaps: { ...queueItem().gaps, missingPhone: true } }), settingsFixture());

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('recrawl_failed');
    expect(result.reason).toContain('robots.txt');
  });

  it('finds nothing real to fix and reports no_real_fix_found rather than writing anything', async () => {
    getShadowProfile.mockResolvedValue(shadowProfileFixture({ description: 'A'.repeat(200) }));
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockResolvedValue({ rootUrl: 'https://example-venue.test/', finalRootUrl: 'https://example-venue.test/', pages: [], failures: [] });

    const item = queueItem({ gaps: { ...queueItem().gaps, missingPhone: true } });
    const result = await auditOneSupplier(item, settingsFixture());

    expect(result.outcome).toBe('no_real_fix_found');
    expect(result.skipped).toContainEqual({ field: 'publicPhone', reason: 'no_phone_number_found_on_recrawl' });
    expect(refreshEventFlowSupplierData).not.toHaveBeenCalled();
  });

  it('always skips tags and package-photo gaps: no reliable deterministic source exists yet', async () => {
    getShadowProfile.mockResolvedValue(shadowProfileFixture());
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockResolvedValue(crawlResultWithMedia());

    const item = queueItem({
      gaps: {
        missingCoverImage: false,
        missingGalleryImages: false,
        missingDescription: false,
        missingPhone: false,
        missingTags: true,
        packagesMissingPhotos: [{ id: 'pkg_1', title: 'Day package' }],
      },
    });
    const result = await auditOneSupplier(item, settingsFixture());

    expect(result.outcome).toBe('no_real_fix_found');
    expect(result.skipped).toContainEqual({ field: 'tags', reason: 'no_deterministic_service_tag_extraction_yet' });
    expect(result.skipped).toContainEqual({ field: 'packagesMissingPhotos', reason: 'no_reliable_photo_to_package_matching_yet' });
  });

  it('fixes a real cover-image gap from the recrawl and refreshes EventFlow with a full, merged payload', async () => {
    const profile = shadowProfileFixture({ description: 'A'.repeat(200) });
    getShadowProfile.mockResolvedValue(profile);
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockResolvedValue(crawlResultWithMedia());
    refreshEventFlowSupplierData.mockResolvedValue({ status: 'refreshed', supplierId: 'sup_bot_1', slug: 'example-venue' });

    const item = queueItem({ gaps: { ...queueItem().gaps, missingCoverImage: true } });
    const result = await auditOneSupplier(item, settingsFixture());

    expect(result.outcome).toBe('refreshed');
    expect(result.fixed).toEqual(['coverImage']);
    expect(refreshEventFlowSupplierData).toHaveBeenCalledTimes(1);
    const sentProfile = refreshEventFlowSupplierData.mock.calls[0][0].profile as ShadowProfile;
    expect(sentProfile.coverImage).toBe('https://example-venue.test/hero.jpg');
    // Untouched fields must survive unchanged -- the refresh endpoint is a
    // wholesale field replace, not a merge, so silently dropping them here
    // would wipe them on EventFlow's side.
    expect(sentProfile.businessName).toBe(profile.businessName);
    expect(sentProfile.category).toBe(profile.category);
    expect(sentProfile.description).toBe(profile.description);
    expect(saveShadowProfile).toHaveBeenCalledWith(expect.objectContaining({ coverImage: 'https://example-venue.test/hero.jpg' }));
  });

  it('fixes a real phone gap using the tel: href on the recrawled page', async () => {
    getShadowProfile.mockResolvedValue(shadowProfileFixture());
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockResolvedValue(crawlResultWithMedia());
    refreshEventFlowSupplierData.mockResolvedValue({ status: 'refreshed', supplierId: 'sup_bot_1', slug: 'example-venue' });

    const item = queueItem({ gaps: { ...queueItem().gaps, missingPhone: true } });
    const result = await auditOneSupplier(item, settingsFixture());

    expect(result.outcome).toBe('refreshed');
    expect(result.fixed).toEqual(['publicPhone']);
    const sentProfile = refreshEventFlowSupplierData.mock.calls[0][0].profile as ShadowProfile;
    expect(sentProfile.publicPhone).toBe('02920000000');
  });

  it('reports the refresh failure and does not persist the local profile when EventFlow rejects the write', async () => {
    getShadowProfile.mockResolvedValue(shadowProfileFixture());
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockResolvedValue(crawlResultWithMedia());
    refreshEventFlowSupplierData.mockResolvedValue({ status: 'failed', reason: 'eventflow_http_500' });

    const item = queueItem({ gaps: { ...queueItem().gaps, missingPhone: true } });
    const result = await auditOneSupplier(item, settingsFixture());

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('refresh_failed: eventflow_http_500');
    expect(saveShadowProfile).not.toHaveBeenCalled();
  });
});

describe('main', () => {
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutWrite.mockClear();
  });

  afterEach(() => {
    stdoutWrite.mockReset();
  });

  it('skips the whole cycle without calling the audit queue when the bot is stopped', async () => {
    getSettings.mockResolvedValue(settingsFixture({ runState: 'emergency_stopped' }));

    await main();

    expect(fetchAuditQueue).not.toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('bot_stopped'));
  });

  it('skips the whole cycle when refreshEnabled is off', async () => {
    getSettings.mockResolvedValue(settingsFixture({ refreshEnabled: false }));

    await main();

    expect(fetchAuditQueue).not.toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('refresh_disabled'));
  });

  it('skips the whole cycle when the daily crawl budget is already exhausted', async () => {
    getSettings.mockResolvedValue(settingsFixture({ maxCrawlsPerDay: 50 }));
    getTodayCrawlCount.mockResolvedValue(50);

    await main();

    expect(fetchAuditQueue).not.toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('crawl_budget_exhausted'));
  });

  it('audits every item the queue returns, up to the per-run cap, when budget allows', async () => {
    getSettings.mockResolvedValue(settingsFixture());
    getTodayCrawlCount.mockResolvedValue(0);
    fetchAuditQueue.mockResolvedValue({
      status: 'fetched',
      totalPublished: 12,
      totalNeedingWork: 3,
      queue: [queueItem(), queueItem({ supplierId: 'sup_bot_2', candidateId: 'candidate_2' })],
    });
    getShadowProfile.mockResolvedValue(null); // every item skips (no local profile) -- simplest deterministic path

    await main();

    expect(getShadowProfile).toHaveBeenCalledTimes(2);
    expect(recordAuditEvent).toHaveBeenCalledTimes(2);
  });
});
