import { getQueue } from '../queues/index.js';
import { getCampaign } from '../repositories/campaign.repository.js';
import { setCandidateStatus, upsertDiscoveredCandidate } from '../repositories/candidate.repository.js';
import { isSuppressed } from '../repositories/suppression.repository.js';
import { canonicalDomain, canonicalizePublicHttpUrl } from '../utils/url.js';

const DEFAULT_PILOT_CAMPAIGN = 'campaign_south_wales_venues_pilot';

export async function seedCandidate(input: {
  url: string;
  campaignId?: string;
  categoryHint?: string;
  locationHint?: string;
  titleHint?: string;
}) {
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

  const shouldQueue = saved.created || saved.candidate.status === 'discovered';
  if (shouldQueue) {
    await setCandidateStatus(saved.candidate.id, 'queued_for_crawl');
    await getQueue('crawl').add(
      'crawl-candidate',
      { candidateId: saved.candidate.id, trigger: 'manual_seed' },
      {
        jobId: `crawl-${saved.candidate.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      },
    );
  }

  return {
    candidate: {
      ...saved.candidate,
      status: shouldQueue ? 'queued_for_crawl' : saved.candidate.status,
    },
    created: saved.created,
    crawlQueued: shouldQueue,
  };
}
