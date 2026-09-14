import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';

// Same reasoning as tests/eventflow-supplier-lookup.test.ts: the integration
// vars aren't set in the shared test env, and env.ts freezes them from
// process.env once at import time.
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

const { unpublishFromEventFlow } = await import('../src/services/eventflow-unpublish.service.js');

describe('EventFlow unpublish client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // Not restoreAllMocks(): that would reset recordAuditEvent's
    // mockResolvedValue back to a bare mock returning undefined
    // synchronously, and the service under test unconditionally chains
    // .catch() onto its result.
    vi.restoreAllMocks();
    recordAuditEvent.mockReset().mockResolvedValue(undefined);
  });

  it('signs the request against the per-supplier unpublish URL and records success', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, supplierId: 'sup_bot_1' }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await unpublishFromEventFlow({
      candidateId: 'candidate_1',
      supplierId: 'sup_bot_1',
      reason: 'Wrong region for this marketplace',
    });

    expect(result).toEqual({ status: 'unpublished' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://event-flow.example/api/v1/internal/supplier-bot/suppliers/sup_bot_1/unpublish');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-eventflow-bot-timestamp']).toMatch(/^\d+$/);
    expect(headers['x-eventflow-bot-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'Wrong region for this marketplace' });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      'eventflow-unpublish',
      'eventflow.unpublish_succeeded',
      expect.objectContaining({ candidateId: 'candidate_1', supplierId: 'sup_bot_1' }),
    );
  });

  it('reports not_found for a 404, without treating it as a failure that should retry indefinitely', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'Supplier not found' })));

    const result = await unpublishFromEventFlow({
      candidateId: 'candidate_1',
      supplierId: 'sup_bot_missing',
      reason: 'test',
    });

    expect(result).toEqual({ status: 'not_found', reason: 'eventflow_supplier_not_found' });
  });

  it('reports not_bot_managed for a 409, matching the EventFlow-side ownership guard', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(409, { error: 'Supplier is not a bot-managed unclaimed profile' })),
    );

    const result = await unpublishFromEventFlow({
      candidateId: 'candidate_1',
      supplierId: 'sup_bot_claimed',
      reason: 'test',
    });

    expect(result).toEqual({ status: 'not_bot_managed', reason: 'eventflow_supplier_not_bot_managed' });
  });

  it('reports failed and logs on a network error, without throwing', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await unpublishFromEventFlow({
      candidateId: 'candidate_1',
      supplierId: 'sup_bot_1',
      reason: 'test',
    });

    expect(result).toEqual({ status: 'failed', reason: 'network down' });
    expect(errorSpy).toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(
      'eventflow-unpublish',
      'eventflow.unpublish_failed',
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
    const { unpublishFromEventFlow: unpublishUnconfigured } = await import('../src/services/eventflow-unpublish.service.js');

    const result = await unpublishUnconfigured({ candidateId: 'candidate_1', supplierId: 'sup_bot_1', reason: 'test' });

    expect(result).toEqual({ status: 'not_configured', reason: 'eventflow_integration_not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.doUnmock('../src/config/env.js');
  });
});
