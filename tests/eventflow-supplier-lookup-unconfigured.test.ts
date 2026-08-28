import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventFlowAlreadyHasSupplierForDomain } from '../src/services/eventflow-supplier-lookup.service.js';

// Deliberately does not mock src/config/env.js -- EVENTFLOW_INTERNAL_BASE_URL
// and EVENTFLOW_BOT_HMAC_SECRET are both unset by default in the shared test
// env (tests/setup-env.ts), which is exactly the "integration not
// configured" case this file tests. Kept in its own file, separate from
// tests/eventflow-supplier-lookup.test.ts, because that file's top-level
// vi.mock of env.js (needed for its own tests) can't be reliably overridden
// per-test with vi.doMock for just one case.
describe('EventFlow pre-crawl supplier existence lookup, integration not configured', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false without making any network call when EventFlow integration is not configured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(eventFlowAlreadyHasSupplierForDomain('example.com')).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
