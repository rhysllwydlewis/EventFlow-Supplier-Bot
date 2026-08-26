import { getQueue } from '../queues/index.js';
import { listCandidatesByStatus } from '../repositories/candidate.repository.js';

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function browserCrawlJobId(candidateId: string, day = utcDay()): string {
  return `browser-crawl-${candidateId}-${day}`;
}

export async function enqueueBrowserCrawlCandidate(candidateId: string, trigger: string): Promise<boolean> {
  const queue = getQueue('browserCrawl');
  const jobId = browserCrawlJobId(candidateId);
  if (await queue.getJob(jobId)) return false;

  await queue.add(
    'browser-crawl-candidate',
    { candidateId, trigger },
    {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
    },
  );
  return true;
}

export async function reconcileQueuedBrowserCrawlCandidates(limit = 100): Promise<number> {
  const candidates = await listCandidatesByStatus('queued_for_browser_crawl', limit);
  let queued = 0;
  for (const candidate of candidates) {
    if (await enqueueBrowserCrawlCandidate(candidate.id, 'reconciler')) queued += 1;
  }
  return queued;
}
