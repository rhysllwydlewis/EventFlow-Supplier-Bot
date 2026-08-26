import { getQueue } from '../queues/index.js';
import { listCandidatesByStatus } from '../repositories/candidate.repository.js';

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function crawlJobId(candidateId: string, day = utcDay()): string {
  return `crawl-${candidateId}-${day}`;
}

export async function enqueueCrawlCandidate(candidateId: string, trigger: string): Promise<boolean> {
  const queue = getQueue('crawl');
  const jobId = crawlJobId(candidateId);
  const existing = await queue.getJob(jobId);
  if (existing) {
    return false;
  }

  await queue.add(
    'crawl-candidate',
    { candidateId, trigger },
    {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
  return true;
}

export async function reconcileQueuedCrawlCandidates(limit = 250): Promise<number> {
  const candidates = await listCandidatesByStatus('queued_for_crawl', limit);
  let queued = 0;
  for (const candidate of candidates) {
    if (await enqueueCrawlCandidate(candidate.id, 'reconciler')) {
      queued += 1;
    }
  }
  return queued;
}
