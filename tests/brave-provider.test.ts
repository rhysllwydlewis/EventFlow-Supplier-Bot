import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { BraveDiscoveryProvider } from '../src/providers/discovery/brave.provider.js';

// BRAVE_API_KEY isn't set in the shared test env (tests/setup-env.ts), and
// src/config/env.ts freezes `env` from process.env once at import time --
// setting process.env.BRAVE_API_KEY at test runtime wouldn't reach it, so
// the config module itself is mocked for this file instead. vi.mock is
// hoisted above these imports by Vitest, so brave.provider.ts's own
// `import { env } from '../../config/env.js'` resolves to this mock.
vi.mock('../src/config/env.js', async importOriginal => {
  const actual = await importOriginal<typeof EnvModule>();
  return { ...actual, env: { ...actual.env, BRAVE_API_KEY: 'test-brave-key' } };
});

function jsonResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({}), { status, headers });
}

describe('Brave discovery provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('logs a distinct rate-limit warning (with Retry-After, when sent) on HTTP 429, unlike other failures', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, { 'retry-after': '30' })));

    const provider = new BraveDiscoveryProvider();
    await expect(provider.search({ query: 'wedding venues Cardiff' })).rejects.toThrow('Brave Search failed with HTTP 429');

    expect(warnSpy).toHaveBeenCalledWith(
      { retryAfter: '30' },
      'Brave Search rate-limited this request (HTTP 429)',
    );
  });

  it('does not log the rate-limit warning for a non-429 failure', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500)));

    const provider = new BraveDiscoveryProvider();
    await expect(provider.search({ query: 'wedding venues Cardiff' })).rejects.toThrow('Brave Search failed with HTTP 500');

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
