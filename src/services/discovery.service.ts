import { env } from '../config/env.js';
import type { Campaign } from '../domain/campaign.js';
import { logger } from '../lib/logger.js';
import { getDiscoveryProvider } from '../providers/discovery/index.js';
import {
  getCandidateByCanonicalDomain,
  upsertDiscoveredCandidate,
} from '../repositories/candidate.repository.js';
import { getPublishedSupplierByDomain } from '../repositories/published-supplier.repository.js';
import { isSuppressed } from '../repositories/suppression.repository.js';
import { tryClaimDailyAcquisitionSlot } from './acquisition-budget.service.js';
import { evaluateDiscoverySearchResult } from './discovery-result-quality.service.js';
import { buildDiscoveryQueries } from './query-builder.service.js';

export interface DiscoveryCycleResult {
  provider: string;
  queriesRun: number;
  resultsSeen: number;
  candidatesCreated: number;
  candidateIdsCreated: string[];
  duplicatesSkipped: number;
  suppressedSkipped: number;
  alreadyPublishedSkipped: number;
  qualityFilteredSkipped: number;
  persistenceBlocked: number;
  limitReached: boolean;
}

export async function runDiscoveryCycle(
  campaign: Campaign,
  providerName = 'brave',
  maxCandidates = campaign.dailyHardLimit,
  globalHardLimit = maxCandidates,
): Promise<DiscoveryCycleResult> {
  const provider = getDiscoveryProvider(providerName);
  const health = await provider.health();
  if (!health.healthy) {
    throw new Error(health.message || `${providerName} discovery provider is unavailable`);
  }

  const candidateLimit = Math.max(0, Math.floor(maxCandidates));
  const result: DiscoveryCycleResult = {
    provider: providerName,
    queriesRun: 0,
    resultsSeen: 0,
    candidatesCreated: 0,
    candidateIdsCreated: [],
    duplicatesSkipped: 0,
    suppressedSkipped: 0,
    alreadyPublishedSkipped: 0,
    qualityFilteredSkipped: 0,
    persistenceBlocked: 0,
    limitReached: candidateLimit === 0,
  };

  if (candidateLimit === 0) {
    return result;
  }

  outer: for (const discoveryQuery of buildDiscoveryQueries(campaign)) {
    const items = await provider.search({
      query: discoveryQuery.query,
      country: 'gb',
      language: 'en',
      count: 20,
    });
    result.queriesRun += 1;
    result.resultsSeen += items.length;

    for (const item of items) {
      if (result.candidatesCreated >= candidateLimit) {
        result.limitReached = true;
        break outer;
      }

      const qualityDecision = evaluateDiscoverySearchResult(item, discoveryQuery.category);
      if (!qualityDecision.eligible || !qualityDecision.domain) {
        result.qualityFilteredSkipped += 1;
        continue;
      }
      const domain = qualityDecision.domain;

      if (await isSuppressed(domain, 'do_not_crawl')) {
        result.suppressedSkipped += 1;
        continue;
      }

      // A Hard Reset wipes candidate history so the bot can start over, but
      // must never make it forget a domain it has already published to
      // EventFlow -- otherwise every future discovery cycle re-crawls,
      // re-extracts and re-assesses suppliers already live on the site,
      // burning real crawl and AI budget on work that's already done.
      // published_suppliers is the durable record that survives a reset.
      if (await getPublishedSupplierByDomain(domain)) {
        result.alreadyPublishedSkipped += 1;
        continue;
      }

      if (!provider.capabilities.supportsPersistence) {
        result.persistenceBlocked += 1;
        continue;
      }

      if (await getCandidateByCanonicalDomain(domain)) {
        result.duplicatesSkipped += 1;
        continue;
      }

      const slotClaimed = await tryClaimDailyAcquisitionSlot(
        campaign.id,
        campaign.dailyHardLimit,
        globalHardLimit,
      );
      if (!slotClaimed) {
        result.limitReached = true;
        break outer;
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

  result.limitReached = result.limitReached || result.candidatesCreated >= candidateLimit;
  logger.info({ campaignId: campaign.id, candidateLimit, ...result }, 'Discovery cycle completed');
  if (!env.BRAVE_PERSISTENCE_ALLOWED && providerName === 'brave') {
    logger.warn({ persistenceBlocked: result.persistenceBlocked }, 'Brave discovery ran with persistence gated');
  }
  return result;
}
