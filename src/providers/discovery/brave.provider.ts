import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import type {
  DiscoveryProvider,
  DiscoveryProviderCapabilities,
  DiscoverySearchInput,
  DiscoverySearchResult,
} from './provider.js';

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

export class BraveDiscoveryProvider implements DiscoveryProvider {
  readonly capabilities: DiscoveryProviderCapabilities = {
    provider: 'brave',
    supportsPersistence: env.BRAVE_PERSISTENCE_ALLOWED,
    supportsCommercialUse: true,
    supportsContactDiscovery: false,
    supportsLocationSearch: true,
    supportsImages: false,
  };

  async health(): Promise<{ healthy: boolean; message?: string }> {
    if (!env.BRAVE_API_KEY) {
      return { healthy: false, message: 'BRAVE_API_KEY is not configured' };
    }
    return { healthy: true };
  }

  async search(input: DiscoverySearchInput): Promise<DiscoverySearchResult[]> {
    if (!env.BRAVE_API_KEY) {
      throw new Error('Brave Search is not configured');
    }

    const params = new URLSearchParams({
      q: input.query,
      count: String(Math.min(Math.max(input.count ?? 20, 1), 20)),
      search_lang: input.language ?? 'en',
      country: input.country ?? 'gb',
    });

    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': env.BRAVE_API_KEY,
        'User-Agent': 'EventFlowSupplierBot/0.1',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      if (response.status === 429) {
        // A generic "HTTP 429" log line reads the same as any other
        // transient failure -- surfacing the provider's own Retry-After
        // (when it sends one) gives an operator looking at logs the actual
        // signal that this is rate-limiting specifically, not a one-off
        // error, without building a full proactive-backoff mechanism this
        // provider doesn't otherwise have.
        logger.warn(
          { retryAfter: response.headers.get('retry-after') },
          'Brave Search rate-limited this request (HTTP 429)',
        );
      }
      throw new Error(`Brave Search failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as BraveResponse;
    return (payload.web?.results ?? [])
      .filter(result => result.url && result.title)
      .map((result, index) => ({
        url: result.url as string,
        title: result.title as string,
        ...(result.description ? { snippet: result.description } : {}),
        rank: index + 1,
      }));
  }
}
