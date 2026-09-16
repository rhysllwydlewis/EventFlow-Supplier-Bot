import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import type { ShadowProfile } from '../src/domain/shadow-profile.js';

// Same reasoning as tests/eventflow-supplier-lookup.test.ts and
// tests/eventflow-unpublish.test.ts: the integration vars aren't set in the
// shared test env, and env.ts freezes them from process.env once at import
// time.
vi.mock('../src/config/env.js', async importOriginal => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    env: {
      ...actual.env,
      EVENTFLOW_INTERNAL_BASE_URL: 'https://event-flow.example',
      EVENTFLOW_BOT_HMAC_SECRET: 'test-eventflow-hmac-secret-that-is-long-enough',
    },
  };
});

const recordAuditEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/repositories/audit.repository.js', () => ({ recordAuditEvent }));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const { fetchAuditQueue, refreshEventFlowSupplierData } = await import(
  '../src/services/eventflow-quality-audit.service.js'
);

function baseProfile(overrides: Partial<ShadowProfile> = {}): ShadowProfile {
  return {
    candidateId: 'candidate_1',
    businessName: 'Example Venue',
    category: 'Venues',
    location: 'Cardiff',
    website: 'https://example-venue.test/',
    description: 'Example Venue is a venues supplier serving Cardiff, listed on EventFlow from publicly available business information. This profile can be claimed by the business owner to add full details, packages and photos.',
    publicEmail: null,
    publicPhone: '029 2000 0000',
    advertisedPrices: [],
    services: [],
    packages: [],
    evidenceIds: [],
    profileImage: null,
    profileImageEvidence: null,
    coverImage: 'https://example-venue.test/hero.jpg',
    images: ['https://example-venue.test/hero.jpg'],
    mediaEvidence: [],
    dataConfidence: 60,
    publicationQuality: 60,
    generatedAt: new Date().toISOString(),
    generatorVersion: 'deterministic-shadow-profile-image-v3',
    ...overrides,
  };
}

describe('EventFlow audit-queue fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('signs the request the same way every other Supplier Bot -> EventFlow call does', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { totalPublished: 5, totalNeedingWork: 2, queue: [] }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchAuditQueue({ limit: 10, excludeSupplierIds: ['sup_1'] });

    expect(result).toEqual({ status: 'fetched', totalPublished: 5, totalNeedingWork: 2, queue: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://event-flow.example/api/v1/internal/supplier-bot/suppliers/audit-queue');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-eventflow-bot-timestamp']).toMatch(/^\d+$/);
    expect(headers['x-eventflow-bot-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(JSON.parse(String(init.body))).toEqual({ limit: 10, excludeSupplierIds: ['sup_1'] });
  });

  it('parses a real queue item, including a zero-length packagesMissingPhotos array', async () => {
    const item = {
      supplierId: 'sup_bot_1',
      candidateId: 'candidate_1',
      website: 'https://example-venue.test/',
      slug: 'example-venue',
      name: 'Example Venue',
      publicationScope: 'public_unclaimed',
      publishedUnclaimedAt: '2026-09-01T00:00:00.000Z',
      completenessScore: 50,
      gaps: {
        missingCoverImage: true,
        missingGalleryImages: false,
        missingDescription: false,
        missingPhone: false,
        missingTags: false,
        packagesMissingPhotos: [{ id: 'pkg_1', title: 'Day package' }],
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { totalPublished: 1, totalNeedingWork: 1, queue: [item] })));

    const result = await fetchAuditQueue();

    expect(result.status).toBe('fetched');
    expect(result.status === 'fetched' && result.queue).toEqual([item]);
  });

  it('reports not_configured when the integration env vars are missing, without calling fetch', async () => {
    vi.doMock('../src/config/env.js', async importOriginal => {
      const actual = await importOriginal<typeof EnvModule>();
      return { ...actual, env: { ...actual.env, EVENTFLOW_INTERNAL_BASE_URL: undefined, EVENTFLOW_BOT_HMAC_SECRET: undefined } };
    });
    vi.resetModules();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { fetchAuditQueue: fetchUnconfigured } = await import('../src/services/eventflow-quality-audit.service.js');

    const result = await fetchUnconfigured();

    expect(result).toEqual({ status: 'not_configured', reason: 'eventflow_integration_not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.doUnmock('../src/config/env.js');
  });

  it('fails rather than silently proceeding on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })));

    const result = await fetchAuditQueue();

    expect(result).toEqual({ status: 'failed', reason: 'boom' });
  });

  it('fails on a malformed response body that does not match the expected schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { unexpected: 'shape' })));

    const result = await fetchAuditQueue();

    expect(result.status).toBe('failed');
  });
});

describe('EventFlow quality-audit refresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    recordAuditEvent.mockReset().mockResolvedValue(undefined);
  });

  it('signs the request against the same refresh endpoint the original publish used', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        supplierId: 'sup_bot_1',
        slug: 'example-venue',
        status: 'active',
        ownershipStatus: 'unclaimed',
        created: false,
        idempotent: true,
        refreshed: true,
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const profile = baseProfile();
    const result = await refreshEventFlowSupplierData({ profile });

    expect(result).toEqual({ status: 'refreshed', supplierId: 'sup_bot_1', slug: 'example-venue' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://event-flow.example/api/v1/internal/supplier-bot/suppliers');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-eventflow-bot-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    const body = JSON.parse(String(init.body));
    expect(body.candidateId).toBe('candidate_1');
    expect(body.businessName).toBe('Example Venue');
    expect(body.category).toBe('Venues');
    expect(body.website).toBe('https://example-venue.test/');
    // publicationScope is deliberately never sent -- EventFlow's own
    // effectivePublicationScope() keeps the existing scope regardless.
    expect(body.publicationScope).toBeUndefined();
    expect(recordAuditEvent).toHaveBeenCalledWith(
      'eventflow-quality-audit',
      'eventflow.quality_refresh_succeeded',
      expect.objectContaining({ candidateId: 'candidate_1', supplierId: 'sup_bot_1' }),
    );
  });

  it('nulls out a publicPhone longer than EventFlow\'s field, the same guard eventflow-ingestion.service.ts applies', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        supplierId: 'sup_bot_1',
        slug: 'example-venue',
        status: 'active',
        ownershipStatus: 'unclaimed',
        created: false,
        idempotent: true,
        refreshed: true,
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await refreshEventFlowSupplierData({ profile: baseProfile({ publicPhone: '029 2012 3456 ext. 123' }) });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).publicPhone).toBeNull();
  });

  it('reports conflict on a 409 without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(409, { error: 'A supplier with this website already exists' })));

    const result = await refreshEventFlowSupplierData({ profile: baseProfile() });

    expect(result).toEqual({ status: 'conflict', reason: 'A supplier with this website already exists' });
  });

  it('reports failed and logs on a network error, without throwing', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await refreshEventFlowSupplierData({ profile: baseProfile() });

    expect(result).toEqual({ status: 'failed', reason: 'network down' });
    expect(errorSpy).toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(
      'eventflow-quality-audit',
      'eventflow.quality_refresh_failed',
      expect.objectContaining({ candidateId: 'candidate_1', reason: 'network down' }),
    );
  });

  it('reports not_configured when the integration env vars are missing, without calling fetch', async () => {
    vi.doMock('../src/config/env.js', async importOriginal => {
      const actual = await importOriginal<typeof EnvModule>();
      return { ...actual, env: { ...actual.env, EVENTFLOW_INTERNAL_BASE_URL: undefined, EVENTFLOW_BOT_HMAC_SECRET: undefined } };
    });
    vi.resetModules();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { refreshEventFlowSupplierData: refreshUnconfigured } = await import(
      '../src/services/eventflow-quality-audit.service.js'
    );

    const result = await refreshUnconfigured({ profile: baseProfile() });

    expect(result).toEqual({ status: 'not_configured', reason: 'eventflow_integration_not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.doUnmock('../src/config/env.js');
  });
});
