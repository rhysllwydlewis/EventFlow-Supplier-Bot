import { env } from '../config/env.js';
import type { Campaign } from '../domain/campaign.js';
import { logger } from '../lib/logger.js';
import { getDiscoveryProvider } from '../providers/discovery/index.js';
import { upsertDiscoveredCandidate } from '../repositories/candidate.repository.js';
import { isSuppressed } from '../repositories/suppression.repository.js';
import { buildDiscoveryQueries } from './query-builder.service.js';

export interface DiscoveryCycleResult {
  provider: string;
  queriesRun: number;
  resultsSeen: number;
  candidatesCreated: number;
  candidateIdsCreated: string[];
  duplicatesSkipped: number;
  suppressedSkipped: number;
  persistenceBlocked: number;
}

export async function runDiscoveryCycle(
  campaign: Campaign,
  providerName = 'brave',
): Promise<DiscoveryCycleResult> {
  const provider = getDiscoveryProvider(providerName);
  const health = await provider.health();
  if (!health.healthy) {
    throw new Error(health.message || `${providerName} discovery provider is unavailable`);
  }

  const result: DiscoveryCycleResult = {
    provider: providerName,
    queriesRun: 0,
    resultsSeen: 0,
    candidatesCreated: 0,
    candidateIdsCreated: [],
    duplicatesSkipped: 0,
    suppressedSkipped: 0,
    persistenceBlocked: 0,
  };

  for (const discoveryQuery of buildDiscoveryQueries(campaign)) {
    const items = await provider.search({
      query: discoveryQuery.query,
      country: 'gb',
      language: 'en',
      count: 20,
    });
    result.queriesRun += 1;
    result.resultsSeen += items.length;

    for (const item of items) {
      let domain: string;
      try {
        domain = new URL(item.url).hostname.toLowerCase().replace(/^www\./, '');
      } catch {
        continue;
      }

      if (await isSuppressed(domain, 'do_not_crawl')) {
        result.suppressedSkipped += 1;
        continue;
      }

      if (!provider.capabilities.supportsPersistence) {
        result.persistenceBlocked += 1;
        continue;
      }

      const saved = await upsertDiscoveredCandidate({
        campaignId: campaign.id,
        provider: providerName,
        discoveryQuery: discoveryQuery.query,
        sourceUrl: item.url,
        titleHint: item.title,
        ...(item.snippet ? { snippetHint: item.snippet } : {}),
        categoryHint: discoveryQuery.category,
        locationHint: discoveryQuery.location,
      });
      if (saved.created) {
        result.candidatesCreated += 1;
        result.candidateIdsCreated.push(saved.candidate.id);
      } else {
        result.duplicatesSkipped += 1;
      }
    }
  }

  logger.info({ campaignId: campaign.id, ...result }, 'Discovery cycle completed');
  if (!env.BRAVE_PERSISTENCE_ALLOWED && providerName === 'brave') {
    logger.warn({ persistenceBlocked: result.persistenceBlocked }, 'Brave discovery ran with persistence gated');
  }
  return result;
}
