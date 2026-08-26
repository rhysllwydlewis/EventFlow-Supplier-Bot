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
  deadLetter: 'dead-letter',
});

export type QueueKey = keyof typeof QUEUE_NAMES;

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
