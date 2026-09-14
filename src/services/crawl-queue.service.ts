import { getQueue } from '../queues/index.js';
import { listCandidatesByStatus } from '../repositories/candidate.repository.js';

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function legacyCrawlJobId(candidateId: string): string {
  return `crawl-${candidateId}`;
}

export function crawlJobId(candidateId: string, day = utcDay()): string {
  return `crawl-${candidateId}-${day}`;
}

export async function enqueueCrawlCandidate(candidateId: string, trigger: string): Promise<boolean> {
  const queue = getQueue('crawl');
  const jobId = crawlJobId(candidateId);
  const [existing, legacyExisting] = await Promise.all([
    queue.getJob(jobId),
    queue.getJob(legacyCrawlJobId(candidateId)),
  ]);
  if (existing || legacyExisting) {
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

// Bypasses the day-scoped/legacy jobId dedup above entirely -- for an
// operator deliberately forcing a fresh crawl of a candidate that (unlike
// every other caller of enqueueCrawlCandidate) is known to have already
// been crawled, possibly today. Confirmed live in production: the initial
// live-listing-remediation run (2026-09-14) found an existing job under
// either jobId for all three of its recrawl targets and silently queued
// nothing, because enqueueCrawlCandidate's dedup -- designed to stop
// organic double-discovery, not to be bypassed on request -- has no way to
// distinguish "already covered today" from "an operator wants this redone".
// The unique per-call jobId here can never collide with a prior job.
export async function enqueueForcedCrawlCandidate(candidateId: string, trigger: string): Promise<void> {
  const queue = getQueue('crawl');
  await queue.add(
    'crawl-candidate',
    { candidateId, trigger },
    {
      jobId: `crawl-forced-${candidateId}-${Date.now()}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
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
