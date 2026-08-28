import { getCampaign } from '../repositories/campaign.repository.js';
import {
  countCampaignCandidatesSince,
  countCandidatesSince,
  getCandidateByCanonicalDomain,
  setCandidateStatus,
  upsertDiscoveredCandidate,
} from '../repositories/candidate.repository.js';
import { getPublishedSupplierByDomain } from '../repositories/published-supplier.repository.js';
import { getSettings } from '../repositories/settings.repository.js';
import { isSuppressed } from '../repositories/suppression.repository.js';
import { canonicalDomain, canonicalizePublicHttpUrl } from '../utils/url.js';
import { tryClaimDailyAcquisitionSlot } from './acquisition-budget.service.js';
import { enqueueCrawlCandidate } from './crawl-queue.service.js';
import { remainingDailyAllowance } from './daily-limit.service.js';
import { isKnownNonSupplierDomain } from './discovery-result-quality.service.js';

const DEFAULT_PILOT_CAMPAIGN = 'campaign_south_wales_venues_pilot';

export interface ManualSeedInput {
  url: string;
  campaignId?: string | undefined;
  categoryHint?: string | undefined;
  locationHint?: string | undefined;
  titleHint?: string | undefined;
}

function startOfUtcDayIso(): string {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  return value.toISOString();
}

export async function seedCandidate(input: ManualSeedInput) {
  const campaignId = input.campaignId || DEFAULT_PILOT_CAMPAIGN;
  const campaign = await getCampaign(campaignId);
  if (!campaign) {
    throw new Error('Campaign not found');
  }

  const canonicalUrl = canonicalizePublicHttpUrl(input.url);
  const domain = canonicalDomain(canonicalUrl.href);
  if (await isSuppressed(domain, 'do_not_crawl')) {
    throw new Error('This domain is suppressed from crawling');
  }
  // Manual seeding bypasses the discovery-time quality gate entirely (it's
  // an operator asserting "this is a real supplier"), so apply the same
  // domain check here too -- otherwise a mistyped or copy-pasted directory
  // URL would spend crawl and AI budget on a candidate that could never
  // actually be published (eventflow-publication.service.ts refuses it
  // regardless), with no feedback until someone notices it stuck in review.
  if (isKnownNonSupplierDomain(domain)) {
    throw new Error('This domain is a directory, editorial, government or UGC site, not a supplier');
  }
  // Same reasoning as above, for a domain that is already a live EventFlow
  // supplier (published via this pipeline or the one-profile pilot): a Hard
  // Reset or a re-seed of a domain the operator has simply forgotten about
  // would otherwise spend a full crawl/extraction/compliance cycle on a
  // supplier that's already published.
  if (await getPublishedSupplierByDomain(domain)) {
    throw new Error('This domain is already a published EventFlow supplier');
  }

  const existing = await getCandidateByCanonicalDomain(domain);
  if (!existing) {
    const [settings, campaignAcquiredToday, globalAcquiredToday] = await Promise.all([
      getSettings(),
      countCampaignCandidatesSince(campaignId, startOfUtcDayIso()),
      countCandidatesSince(startOfUtcDayIso()),
    ]);
    const allowance = remainingDailyAllowance(
      campaignAcquiredToday,
      globalAcquiredToday,
      campaign.dailyHardLimit,
      settings.dailyHardLimit,
    );
    if (allowance === 0) {
      throw new Error('Daily supplier acquisition hard limit has been reached');
    }
    const claimed = await tryClaimDailyAcquisitionSlot(
      campaignId,
      campaign.dailyHardLimit,
      settings.dailyHardLimit,
    );
    if (!claimed) {
      throw new Error('Daily supplier acquisition hard limit has been reached');
    }
  }

  const saved = await upsertDiscoveredCandidate({
    campaignId,
    provider: 'manual_seed',
    discoveryQuery: 'manual_seed',
    sourceUrl: canonicalUrl.href,
    ...(input.titleHint ? { titleHint: input.titleHint } : {}),
    ...(input.categoryHint || campaign.categories[0]
      ? { categoryHint: input.categoryHint || campaign.categories[0] }
      : {}),
    ...(input.locationHint || campaign.locations[0]
      ? { locationHint: input.locationHint || campaign.locations[0] }
      : {}),
  });

  const shouldQueue = saved.created || saved.candidate.status === 'discovered' || saved.candidate.status === 'queued_for_crawl';
  let crawlQueued = false;
  if (shouldQueue) {
    await setCandidateStatus(saved.candidate.id, 'queued_for_crawl');
    crawlQueued = await enqueueCrawlCandidate(saved.candidate.id, 'manual_seed');
  }

  return {
    candidate: {
      ...saved.candidate,
      status: shouldQueue ? 'queued_for_crawl' : saved.candidate.status,
    },
    created: saved.created,
    crawlQueued,
  };
}
