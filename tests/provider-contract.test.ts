import { describe, expect, it } from 'vitest';
import type { DiscoveryProvider } from '../src/providers/discovery/provider.js';

const mockProvider: DiscoveryProvider = {
  capabilities: {
    provider: 'mock',
    supportsPersistence: true,
    supportsCommercialUse: true,
    supportsContactDiscovery: false,
    supportsLocationSearch: true,
    supportsImages: false,
  },
  async health() { return { healthy: true }; },
  async search() { return [{ url: 'https://example.com', title: 'Example', rank: 1 }]; },
};

describe('discovery provider contract', () => {
  it('makes persistence an explicit capability', async () => {
    expect(mockProvider.capabilities.supportsPersistence).toBe(true);
    expect((await mockProvider.search({ query: 'venues South Wales' }))[0]?.url).toBe('https://example.com');
  });
});
