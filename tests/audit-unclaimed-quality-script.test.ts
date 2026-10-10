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

const tryClaimProviderSearch = vi.fn();
vi.mock('../src/services/provider-usage.service.js', () => ({ tryClaimProviderSearch }));

const braveSearch = vi.fn();
vi.mock('../src/providers/discovery/index.js', () => ({ getDiscoveryProvider: () => ({ search: braveSearch }) }));

const { auditOneSupplier, activeGapNames, auditControlBlockReason, summarizeRun, main } = await import(
  '../src/scripts/audit-unclaimed-quality.js'
);

// live + running + refreshEnabled is the "everything allowed" baseline for
// this script -- the same bar eventflow-publication.service.ts's
// publicationControlBlockReason requires for any other live EventFlow
// write. Individual tests override one field to exercise each gate.
function settingsFixture(overrides: Partial<BotSettings> = {}): BotSettings {
  return {
    id: 'global',
    mode: 'live',
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

describe('auditControlBlockReason', () => {
  it('allows the run only when running + live + refreshEnabled all hold', () => {
    expect(auditControlBlockReason(settingsFixture())).toBeNull();
  });

  it.each([
    ['paused', 'run_state_paused'],
    ['draining', 'run_state_draining'],
    ['stopped', 'run_state_stopped'],
    ['emergency_stopped', 'emergency_stopped'],
  ] as const)('blocks when runState is %s', (runState, expected) => {
    expect(auditControlBlockReason(settingsFixture({ runState }))).toBe(expected);
  });

  it.each(['shadow', 'dry_run', 'off'] as const)(
    'blocks when mode is %s even though the bot is running (mirrors publicationControlBlockReason)',
    mode => {
      expect(auditControlBlockReason(settingsFixture({ mode }))).toBe('mode_not_live');
    },
  );

  it('blocks when refreshEnabled is off even in live + running', () => {
    expect(auditControlBlockReason(settingsFixture({ refreshEnabled: false }))).toBe('refresh_disabled');
  });

  it('checks runState before mode, matching publicationControlBlockReason precedence', () => {
    expect(auditControlBlockReason(settingsFixture({ runState: 'paused', mode: 'shadow' }))).toBe('run_state_paused');
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

  describe('profiles whose recorded website is a third-party directory', () => {
    const directoryUrl = 'https://wedding-caterers.co.uk/near-me/cardiff';
    const directoryProfile = () =>
      shadowProfileFixture({ businessName: 'Cardiff Catering Company', website: directoryUrl, category: 'Catering' });
    const phoneItem = () => queueItem({ website: directoryUrl, gaps: { ...queueItem().gaps, missingPhone: true } });
    const ownSiteCrawl = (html: string) => ({
      rootUrl: 'https://cardiffcateringcompany.co.uk/',
      finalRootUrl: 'https://cardiffcateringcompany.co.uk/',
      pages: [{ url: 'https://cardiffcateringcompany.co.uk/', contentType: 'text/html', html, bytes: 100 }],
      failures: [],
    });

    beforeEach(() => {
      getShadowProfile.mockResolvedValue(directoryProfile());
      tryClaimDailyCrawlSlot.mockResolvedValue(true);
      tryClaimProviderSearch.mockResolvedValue(true);
      refreshEventFlowSupplierData.mockResolvedValue({ status: 'refreshed', supplierId: 'sup_bot_1', slug: 'x' });
    });

    it('never mines the listing page itself: skips when no better source is found', async () => {
      braveSearch.mockResolvedValue([
        { url: 'https://unrelated.test/', title: 'Some Other Caterer', rank: 1 },
      ]);
      const result = await auditOneSupplier(phoneItem(), settingsFixture());
      expect(result.outcome).toBe('skipped');
      expect(result.reason).toBe('recorded_website_is_a_directory_listing_and_no_better_source_found');
      expect(crawlSupplierSite).not.toHaveBeenCalled();
      expect(refreshEventFlowSupplierData).not.toHaveBeenCalled();
    });

    it('resolves the business\'s own site, verifies it names the business, and fixes the phone from it', async () => {
      braveSearch.mockResolvedValue([
        { url: 'https://cardiffcateringcompany.co.uk/', title: 'Cardiff Catering Company | Weddings', rank: 1 },
      ]);
      crawlSupplierSite.mockResolvedValue(
        ownSiteCrawl('<html><body><h1>Cardiff Catering Company</h1><a href="tel:02920111222">Call</a></body></html>'),
      );
      const result = await auditOneSupplier(phoneItem(), settingsFixture());
      expect(crawlSupplierSite).toHaveBeenCalledWith('https://cardiffcateringcompany.co.uk/', 8);
      expect(result.outcome).toBe('refreshed');
      expect(result.fixed).toEqual(['publicPhone']);
      expect(result.resolvedSource).toEqual({ url: 'https://cardiffcateringcompany.co.uk/', kind: 'own_site' });
      const sent = refreshEventFlowSupplierData.mock.calls[0][0].profile as ShadowProfile;
      expect(sent.publicPhone).toBe('02920111222');
      expect(sent.website).toBe(directoryUrl);
    });

    it('refuses a resolved page that does not itself name the business', async () => {
      braveSearch.mockResolvedValue([
        { url: 'https://cardiffcateringcompany.co.uk/', title: 'Cardiff Catering Company', rank: 1 },
      ]);
      crawlSupplierSite.mockResolvedValue(
        ownSiteCrawl('<html><body><h1>Domain parked</h1><a href="tel:02920111222">Call</a></body></html>'),
      );
      const result = await auditOneSupplier(phoneItem(), settingsFixture());
      expect(result.outcome).toBe('skipped');
      expect(result.reason).toBe('resolved_source_page_does_not_name_the_business');
      expect(refreshEventFlowSupplierData).not.toHaveBeenCalled();
    });

    it('refuses a same-named business whose pages never mention the profile\'s town', async () => {
      braveSearch.mockResolvedValue([
        { url: 'https://cardiffcateringcompany.co.uk/', title: 'Cardiff Catering Company', rank: 1 },
      ]);
      getShadowProfile.mockResolvedValue({ ...directoryProfile(), location: 'Swansea' });
      crawlSupplierSite.mockResolvedValue(
        ownSiteCrawl('<html><body><h1>Cardiff Catering Company</h1><a href="tel:02920111222">Call</a></body></html>'),
      );
      const result = await auditOneSupplier(phoneItem(), settingsFixture());
      expect(result.reason).toBe('resolved_source_page_does_not_mention_the_location');
      expect(refreshEventFlowSupplierData).not.toHaveBeenCalled();
    });

    it('does not reuse photos from a directory profile page', async () => {
      getShadowProfile.mockResolvedValue(directoryProfile());
      braveSearch.mockResolvedValue([
        { url: 'https://poptop.uk.com/cardiff/suppliers/cardiff-catering-company', title: 'Cardiff Catering Company - PopTop', rank: 1 },
      ]);
      crawlSupplierSite.mockResolvedValue(
        ownSiteCrawl(
          '<html><body><h1>Cardiff Catering Company</h1><img src="https://poptop.uk.com/img/a.jpg"><a href="tel:02920111222">Call</a></body></html>',
        ),
      );
      const item = queueItem({ website: directoryUrl, gaps: { ...queueItem().gaps, missingCoverImage: true, missingPhone: true } });
      const result = await auditOneSupplier(item, settingsFixture());
      expect(result.fixed).toEqual(['publicPhone']);
      expect(result.skipped).toContainEqual({ field: 'coverImage', reason: 'no_usable_image_found_on_recrawl' });
    });

    it('skips cleanly when the daily provider search budget is exhausted', async () => {
      tryClaimProviderSearch.mockResolvedValue(false);
      const result = await auditOneSupplier(phoneItem(), settingsFixture());
      expect(result.reason).toBe('daily_provider_search_budget_exhausted');
      expect(braveSearch).not.toHaveBeenCalled();
    });

    it('skips cleanly when the source search itself fails', async () => {
      braveSearch.mockRejectedValue(new Error('Brave Search failed with HTTP 429'));
      const result = await auditOneSupplier(phoneItem(), settingsFixture());
      expect(result.reason).toContain('source_search_failed');
    });
  });

  it('skips the package-photo gap when the recrawl has no page-local, title-matching photo for it', async () => {
    getShadowProfile.mockResolvedValue(shadowProfileFixture());
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockResolvedValue(crawlResultWithMedia());

    const item = queueItem({
      gaps: {
        missingCoverImage: false,
        missingGalleryImages: false,
        missingDescription: false,
        missingPhone: false,
        missingTags: false,
        packagesMissingPhotos: [{ id: 'pkg_1', title: 'Day package' }],
      },
    });
    const result = await auditOneSupplier(item, settingsFixture());

    expect(result.outcome).toBe('no_real_fix_found');
    expect(result.skipped).toContainEqual({ field: 'packagesMissingPhotos', reason: 'no_reliable_photo_to_package_matching_yet' });
    expect(refreshEventFlowSupplierData).not.toHaveBeenCalled();
  });

  it('fixes a real package-photo gap when the recrawl finds a page-local photo whose alt text names the package', async () => {
    const profile = shadowProfileFixture({
      packages: [
        {
          name: 'Silver Package',
          price: '£500',
          priceDisplay: '£500',
          kind: 'advertised_package',
          features: [],
          evidenceIds: [],
          sourceUrl: 'https://example-venue.test/weddings/silver',
          sourceObservedAt: null,
          sourceContentHash: null,
          extractionConfidence: 80,
          priceDetails: null,
          image: null,
        },
      ],
    });
    getShadowProfile.mockResolvedValue(profile);
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockResolvedValue({
      rootUrl: 'https://example-venue.test/',
      finalRootUrl: 'https://example-venue.test/',
      pages: [
        {
          url: 'https://example-venue.test/weddings/silver',
          contentType: 'text/html',
          html:
            '<html><body><img src="https://example-venue.test/photos/silver-table.jpg" alt="Silver package table setting" width="1200" height="800"></body></html>',
          bytes: 200,
        },
      ],
      failures: [],
    });
    refreshEventFlowSupplierData.mockResolvedValue({ status: 'refreshed', supplierId: 'sup_bot_1', slug: 'example-venue' });

    const item = queueItem({
      gaps: { ...queueItem().gaps, packagesMissingPhotos: [{ id: 'pkg_1', title: 'Silver Package' }] },
    });
    const result = await auditOneSupplier(item, settingsFixture());

    expect(result.outcome).toBe('refreshed');
    expect(result.fixed).toEqual(['packages']);
    expect(result.skipped).toEqual([]);
    const sentProfile = refreshEventFlowSupplierData.mock.calls[0][0].profile as ShadowProfile;
    expect(sentProfile.packages).toEqual([
      expect.objectContaining({ name: 'Silver Package', image: 'https://example-venue.test/photos/silver-table.jpg' }),
    ]);
  });

  it('skips the tags gap when the recrawl finds no deterministic service-tag signal', async () => {
    getShadowProfile.mockResolvedValue(shadowProfileFixture());
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockResolvedValue(crawlResultWithMedia());

    const item = queueItem({ gaps: { ...queueItem().gaps, missingTags: true } });
    const result = await auditOneSupplier(item, settingsFixture());

    expect(result.outcome).toBe('no_real_fix_found');
    expect(result.skipped).toContainEqual({ field: 'tags', reason: 'no_deterministic_service_tags_found_on_recrawl' });
    expect(refreshEventFlowSupplierData).not.toHaveBeenCalled();
  });

  it('fixes a real tags gap from JSON-LD serviceType found on the recrawl', async () => {
    const profile = shadowProfileFixture();
    getShadowProfile.mockResolvedValue(profile);
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockResolvedValue({
      rootUrl: 'https://example-venue.test/',
      finalRootUrl: 'https://example-venue.test/',
      pages: [
        {
          url: 'https://example-venue.test/',
          contentType: 'text/html',
          html: '<html><body><script type="application/ld+json">{"@type":"LocalBusiness","name":"Example Venue","serviceType":["Wedding venue","Corporate events"]}</script></body></html>',
          bytes: 200,
        },
      ],
      failures: [],
    });
    refreshEventFlowSupplierData.mockResolvedValue({ status: 'refreshed', supplierId: 'sup_bot_1', slug: 'example-venue' });

    const item = queueItem({ gaps: { ...queueItem().gaps, missingTags: true } });
    const result = await auditOneSupplier(item, settingsFixture());

    expect(result.outcome).toBe('refreshed');
    expect(result.fixed).toEqual(['services']);
    const sentProfile = refreshEventFlowSupplierData.mock.calls[0][0].profile as ShadowProfile;
    expect(sentProfile.services).toEqual(['Wedding venue', 'Corporate events']);
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

  it('does not claim a phone fix when the cleaned number is too long for the EventFlow field', async () => {
    getShadowProfile.mockResolvedValue(shadowProfileFixture());
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockResolvedValue({
      rootUrl: 'https://example-venue.test/',
      finalRootUrl: 'https://example-venue.test/',
      pages: [
        {
          url: 'https://example-venue.test/',
          contentType: 'text/html',
          html: '<html><body><a href="tel:029 2012 3456 ext. 123">Call</a></body></html>',
          bytes: 100,
        },
      ],
      failures: [],
    });

    const item = queueItem({ gaps: { ...queueItem().gaps, missingPhone: true } });
    const result = await auditOneSupplier(item, settingsFixture());

    expect(result.outcome).toBe('no_real_fix_found');
    expect(result.skipped).toContainEqual({ field: 'publicPhone', reason: 'phone_number_too_long_for_eventflow_field' });
    expect(refreshEventFlowSupplierData).not.toHaveBeenCalled();
  });

  it('fixes a real gallery-images gap without touching an already-fine cover image', async () => {
    const profile = shadowProfileFixture({ coverImage: 'https://example-venue.test/existing-cover.jpg' });
    getShadowProfile.mockResolvedValue(profile);
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockResolvedValue(crawlResultWithMedia());
    refreshEventFlowSupplierData.mockResolvedValue({ status: 'refreshed', supplierId: 'sup_bot_1', slug: 'example-venue' });

    const item = queueItem({ gaps: { ...queueItem().gaps, missingGalleryImages: true } });
    const result = await auditOneSupplier(item, settingsFixture());

    expect(result.outcome).toBe('refreshed');
    expect(result.fixed).toEqual(['images']);
    const sentProfile = refreshEventFlowSupplierData.mock.calls[0][0].profile as ShadowProfile;
    expect(sentProfile.images).toEqual(['https://example-venue.test/hero.jpg']);
    // The gap being fixed is the gallery, not the cover -- the existing
    // cover image must survive unchanged.
    expect(sentProfile.coverImage).toBe('https://example-venue.test/existing-cover.jpg');
  });

  it('merges fresh media evidence into the existing array when an image field is fixed, instead of discarding provenance for untouched images', async () => {
    const existingEvidence: ShadowProfile['mediaEvidence'] = [
      {
        url: 'https://example-venue.test/old-gallery-photo.jpg',
        sourcePageUrl: 'https://example-venue.test/gallery',
        kind: 'inline_image',
        alt: null,
        width: null,
        height: null,
        score: 90,
        sameSite: true,
      },
    ];
    const profile = shadowProfileFixture({ mediaEvidence: existingEvidence, images: ['https://example-venue.test/old-gallery-photo.jpg'] });
    getShadowProfile.mockResolvedValue(profile);
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockResolvedValue(crawlResultWithMedia());
    refreshEventFlowSupplierData.mockResolvedValue({ status: 'refreshed', supplierId: 'sup_bot_1', slug: 'example-venue' });

    const item = queueItem({ gaps: { ...queueItem().gaps, missingCoverImage: true } });
    const result = await auditOneSupplier(item, settingsFixture());

    expect(result.outcome).toBe('refreshed');
    const sentProfile = refreshEventFlowSupplierData.mock.calls[0][0].profile as ShadowProfile;
    const evidenceUrls = sentProfile.mediaEvidence.map(item => item.url);
    expect(evidenceUrls).toContain('https://example-venue.test/old-gallery-photo.jpg');
    expect(evidenceUrls).toContain('https://example-venue.test/hero.jpg');
    // The untouched images field (not part of this gap) must still survive.
    expect(sentProfile.images).toEqual(['https://example-venue.test/old-gallery-photo.jpg']);
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

describe('summarizeRun', () => {
  it('counts outcomes and collapses skip reasons into one compact record per supplier', () => {
    const summary = summarizeRun({ totalPublished: 171, totalNeedingWork: 28 }, [
      {
        supplierId: 's1',
        candidateId: 'c1',
        website: 'https://a.example/',
        gapsTargeted: ['missingPhone'],
        fixed: [],
        skipped: [
          { field: 'publicPhone', reason: 'no_phone_number_found_on_recrawl' },
          { field: 'tags', reason: 'no_phone_number_found_on_recrawl' },
        ],
        outcome: 'no_real_fix_found',
      },
      {
        supplierId: 's2',
        candidateId: 'c2',
        website: 'https://b.example/',
        gapsTargeted: ['missingTags'],
        fixed: ['tags'],
        skipped: [],
        outcome: 'refreshed',
      },
      {
        supplierId: 's3',
        candidateId: null,
        website: 'https://c.example/',
        gapsTargeted: [],
        fixed: [],
        skipped: [],
        outcome: 'skipped',
        reason: 'no_candidate_id',
      },
    ]);

    expect(summary).toMatchObject({
      totalPublished: 171,
      totalNeedingWork: 28,
      audited: 3,
      fixedSuppliers: 1,
      outcomes: { no_real_fix_found: 1, refreshed: 1, skipped: 1 },
    });
    const suppliers = summary.suppliers as Array<{ supplierId: string; reasons: string[] }>;
    expect(suppliers[0]?.reasons).toEqual(['no_phone_number_found_on_recrawl']);
    expect(suppliers[2]?.reasons).toEqual(['no_candidate_id']);
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

  it('skips the whole cycle without calling the audit queue when the bot is emergency stopped', async () => {
    getSettings.mockResolvedValue(settingsFixture({ runState: 'emergency_stopped' }));

    await main();

    expect(fetchAuditQueue).not.toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('emergency_stopped'));
  });

  it('skips the whole cycle when the bot is paused, even though that is not emergency_stopped', async () => {
    getSettings.mockResolvedValue(settingsFixture({ runState: 'paused' }));

    await main();

    expect(fetchAuditQueue).not.toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('run_state_paused'));
  });

  it('skips the whole cycle when running in shadow mode, matching publication\'s live-only gate', async () => {
    getSettings.mockResolvedValue(settingsFixture({ mode: 'shadow' }));

    await main();

    expect(fetchAuditQueue).not.toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('mode_not_live'));
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

  it('does not abort the batch when one supplier fails for a reason unrelated to the shared crawl budget', async () => {
    getSettings.mockResolvedValue(settingsFixture());
    getTodayCrawlCount.mockResolvedValue(0);
    fetchAuditQueue.mockResolvedValue({
      status: 'fetched',
      totalPublished: 2,
      totalNeedingWork: 2,
      queue: [
        queueItem({ supplierId: 'sup_bot_1', candidateId: 'candidate_1' }),
        queueItem({ supplierId: 'sup_bot_2', candidateId: 'candidate_2' }),
      ],
    });
    getShadowProfile.mockResolvedValueOnce(shadowProfileFixture()).mockResolvedValueOnce(shadowProfileFixture());
    tryClaimDailyCrawlSlot.mockResolvedValue(true);
    crawlSupplierSite.mockRejectedValueOnce(new Error('DNS lookup failed')).mockResolvedValueOnce(crawlResultWithMedia());

    await main();

    // Both items were attempted -- the first supplier's own recrawl failure
    // must not stop the second from being processed.
    expect(getShadowProfile).toHaveBeenCalledTimes(2);
    expect(crawlSupplierSite).toHaveBeenCalledTimes(2);
  });

  it('stops working the queue once the shared daily crawl budget is exhausted mid-run, rather than failing every remaining item one at a time', async () => {
    getSettings.mockResolvedValue(settingsFixture());
    getTodayCrawlCount.mockResolvedValue(0);
    fetchAuditQueue.mockResolvedValue({
      status: 'fetched',
      totalPublished: 3,
      totalNeedingWork: 3,
      queue: [
        queueItem({ supplierId: 'sup_bot_1', candidateId: 'candidate_1' }),
        queueItem({ supplierId: 'sup_bot_2', candidateId: 'candidate_2' }),
        queueItem({ supplierId: 'sup_bot_3', candidateId: 'candidate_3' }),
      ],
    });
    getShadowProfile.mockResolvedValue(shadowProfileFixture());
    // Budget runs out on the second supplier's claim attempt.
    tryClaimDailyCrawlSlot.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    crawlSupplierSite.mockResolvedValue(crawlResultWithMedia());

    await main();

    expect(getShadowProfile).toHaveBeenCalledTimes(2);
    expect(tryClaimDailyCrawlSlot).toHaveBeenCalledTimes(2);
  });
});
