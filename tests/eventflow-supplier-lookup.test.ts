import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';

// EVENTFLOW_INTERNAL_BASE_URL / EVENTFLOW_BOT_HMAC_SECRET aren't set in the
// shared test env, and src/config/env.ts freezes `env` from process.env
// once at import time -- so the config module itself is mocked for this
// file, same as tests/brave-provider.test.ts.
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const { eventFlowAlreadyHasSupplierForDomain } = await import(
  '../src/services/eventflow-supplier-lookup.service.js'
);

describe('EventFlow pre-crawl supplier existence lookup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns true when EventFlow reports the domain already has a supplier', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { exists: true })));

    await expect(eventFlowAlreadyHasSupplierForDomain('already-live.example')).resolves.toBe(true);
  });

  it('returns false when EventFlow reports no supplier for the domain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { exists: false })));

    await expect(eventFlowAlreadyHasSupplierForDomain('new-domain.example')).resolves.toBe(false);
  });

  it('signs the request the same way every other Supplier Bot -> EventFlow call does', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { exists: false }));
    vi.stubGlobal('fetch', fetchSpy);

    await eventFlowAlreadyHasSupplierForDomain('example.com');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://event-flow.example/api/v1/internal/supplier-bot/suppliers/lookup');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-eventflow-bot-timestamp']).toMatch(/^\d+$/);
    expect(headers['x-eventflow-bot-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(JSON.parse(String(init.body))).toEqual({ domain: 'example.com' });
  });

  it('fails open (returns false, does not throw) on a non-OK response, and warns rather than staying silent', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })));

    await expect(eventFlowAlreadyHasSupplierForDomain('example.com')).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('fails open on a network error, without throwing out of discovery', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(eventFlowAlreadyHasSupplierForDomain('example.com')).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('fails open on a malformed response body that does not match the expected schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { unexpected: 'shape' })));

    await expect(eventFlowAlreadyHasSupplierForDomain('example.com')).resolves.toBe(false);
  });
});
