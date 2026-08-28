import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { getRedis } from '../lib/redis.js';

export const QUEUE_NAMES = Object.freeze({
  orchestration: 'orchestration',
  discovery: 'discovery',
  crawl: 'crawl',
  browserCrawl: 'browser-crawl',
  extraction: 'extraction',
  enrichment: 'enrichment',
  compliance: 'compliance',
  composition: 'composition',
  quality: 'quality',
  publication: 'publication',
  refresh: 'refresh',
});

export type QueueKey = keyof typeof QUEUE_NAMES;

export interface QueueFailureDiagnostic {
  code: string;
  occurredAt: string | null;
  attemptsMade: number;
}

export interface DiscoveryCompletionDiagnostic {
  occurredAt: string | null;
  queriesRun: number;
  resultsSeen: number;
  candidatesCreated: number;
  duplicatesSkipped: number;
  suppressedSkipped: number;
  qualityFilteredSkipped: number;
  persistenceBlocked: number;
  limitReached: boolean;
}

export interface DiscoveryQueueDiagnostic {
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
  };
  latestFailure: QueueFailureDiagnostic | null;
  latestCompletion: DiscoveryCompletionDiagnostic | null;
}

const queues = new Map<QueueKey, Queue>();

export function getQueue(key: QueueKey): Queue {
  const existing = queues.get(key);
  if (existing) {
    return existing;
  }

  const queue = new Queue(QUEUE_NAMES[key], {
    connection: getRedis(),
    prefix: env.BOT_QUEUE_NAMESPACE,
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 5_000 },
      removeOnFail: { age: 14 * 24 * 60 * 60, count: 10_000 },
    },
  });

  queues.set(key, queue);
  return queue;
}

export function classifyQueueFailure(reason: string): string {
  const httpStatus = reason.match(/Brave Search failed with HTTP (\d{3})/i)?.[1];
  if (httpStatus) return `brave_http_${httpStatus}`;

  const normalized = reason.toLowerCase();
  if (
    normalized.includes('brave search is not configured') ||
    normalized.includes('brave_api_key is not configured')
  ) {
    return 'brave_not_configured';
  }
  if (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('aborterror') ||
    normalized.includes('operation was aborted')
  ) {
    return 'brave_timeout';
  }
  if (normalized.includes('fetch failed') || normalized.includes('network')) {
    return 'brave_network_error';
  }
  return 'discovery_job_failed';
}

function timestampToIso(timestamp: number | undefined): string | null {
  return typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : null;
}

function numericResult(value: unknown, key: string): number {
  if (!value || typeof value !== 'object') return 0;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0;
}

function booleanResult(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false;
  return (value as Record<string, unknown>)[key] === true;
}

export async function getDiscoveryQueueDiagnostic(): Promise<DiscoveryQueueDiagnostic> {
  const queue = getQueue('discovery');
  const [counts, failedJobs, completedJobs] = await Promise.all([
    queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
    queue.getJobs(['failed'], 0, 0, false),
    queue.getJobs(['completed'], 0, 0, false),
  ]);
  const failed = failedJobs[0];
  const completed = completedJobs[0];
  return {
    counts: {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
    },
    latestFailure: failed
      ? {
          code: classifyQueueFailure(failed.failedReason || ''),
          occurredAt: timestampToIso(failed.finishedOn),
          attemptsMade: failed.attemptsMade ?? 0,
        }
      : null,
    latestCompletion: completed
      ? {
          occurredAt: timestampToIso(completed.finishedOn),
          queriesRun: numericResult(completed.returnvalue, 'queriesRun'),
          resultsSeen: numericResult(completed.returnvalue, 'resultsSeen'),
          candidatesCreated: numericResult(completed.returnvalue, 'candidatesCreated'),
          duplicatesSkipped: numericResult(completed.returnvalue, 'duplicatesSkipped'),
          suppressedSkipped: numericResult(completed.returnvalue, 'suppressedSkipped'),
          qualityFilteredSkipped: numericResult(completed.returnvalue, 'qualityFilteredSkipped'),
          persistenceBlocked: numericResult(completed.returnvalue, 'persistenceBlocked'),
          limitReached: booleanResult(completed.returnvalue, 'limitReached'),
        }
      : null,
  };
}

export async function getQueueCounts(): Promise<Record<string, Record<string, number>>> {
  const result: Record<string, Record<string, number>> = {};
  for (const key of Object.keys(QUEUE_NAMES) as QueueKey[]) {
    const queue = getQueue(key);
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
    result[key] = {
      ...counts,
      paused: (await queue.isPaused()) ? 1 : 0,
    };
  }
  return result;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map(queue => queue.close()));
  queues.clear();
}
