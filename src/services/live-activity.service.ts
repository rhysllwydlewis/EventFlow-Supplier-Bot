import { getQueue } from '../queues/index.js';
import { getCampaign } from '../repositories/campaign.repository.js';
import { getCandidate } from '../repositories/candidate.repository.js';

// Only the five queues an operator would actually recognise as "the bot
// doing something" -- extraction/enrichment/compliance/composition/quality
// and refresh are declared queue names with no worker consuming them (the
// real per-candidate pipeline runs synchronously inside the crawl job
// handlers), so surfacing them here would just show permanently-empty rows.
const ACTIVITY_QUEUES = ['orchestration', 'discovery', 'crawl', 'browserCrawl', 'publication'] as const;

const QUEUE_VERBS: Record<(typeof ACTIVITY_QUEUES)[number], string> = {
  orchestration: 'Planning campaign coverage',
  discovery: 'Searching for suppliers',
  crawl: 'Crawling',
  browserCrawl: 'Crawling (browser)',
  publication: 'Publishing to EventFlow',
};

export interface LiveActivityEntry {
  queue: string;
  verb: string;
  subject: string;
  startedAt: string | null;
  jobId: string;
}

async function describeJob(queueKey: (typeof ACTIVITY_QUEUES)[number], data: unknown): Promise<string> {
  const payload = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (typeof payload.candidateId === 'string') {
    const candidate = await getCandidate(payload.candidateId);
    return candidate ? candidate.titleHint || candidate.canonicalDomain : payload.candidateId;
  }
  if (typeof payload.campaignId === 'string') {
    const campaign = await getCampaign(payload.campaignId);
    return campaign ? campaign.name : payload.campaignId;
  }
  if (typeof payload.trigger === 'string') {
    return payload.trigger.replaceAll(/[_-]/g, ' ');
  }
  return QUEUE_VERBS[queueKey];
}

export async function getLiveActivity(): Promise<LiveActivityEntry[]> {
  const entries: LiveActivityEntry[] = [];
  for (const queueKey of ACTIVITY_QUEUES) {
    const queue = getQueue(queueKey);
    const activeJobs = await queue.getJobs(['active'], 0, 4);
    for (const job of activeJobs) {
      entries.push({
        queue: queueKey,
        verb: QUEUE_VERBS[queueKey],
        subject: await describeJob(queueKey, job.data),
        startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
        jobId: job.id ?? '',
      });
    }
  }
  return entries;
}
