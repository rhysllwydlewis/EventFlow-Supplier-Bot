import { hostname } from 'node:os';
import { Worker, type Job } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { closeMongo, ensureMongoIndexes } from '../lib/mongo.js';
import { closeRedis, connectRedis, getRedis } from '../lib/redis.js';
import { closeQueues, getQueue, getQueueCounts, QUEUE_NAMES, type QueueKey } from '../queues/index.js';
import { listCampaigns } from '../repositories/campaign.repository.js';
import { writeHeartbeat } from '../repositories/heartbeat.repository.js';
import { getSettings, patchSettings } from '../repositories/settings.repository.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';

const VERSION = '0.1.0';
const workerId = `worker-${hostname()}-${process.pid}`;
const startedAt = new Date().toISOString();
let heartbeatTimer: NodeJS.Timeout | null = null;
let worker: Worker | null = null;

async function heartbeat(status: 'starting' | 'ready' | 'draining' | 'stopping'): Promise<void> {
  await writeHeartbeat({
    workerId,
    processType: 'worker',
    hostname: hostname(),
    pid: process.pid,
    status,
    startedAt,
    updatedAt: new Date().toISOString(),
    version: VERSION,
  });
}

async function handleCoveragePlan(job: Job): Promise<Record<string, unknown>> {
  const settings = await getSettings();
  if (settings.runState !== 'running') {
    return { skipped: true, reason: `run_state_${settings.runState}` };
  }
  if (!settings.discoveryEnabled || settings.mode === 'off') {
    return { skipped: true, reason: 'discovery_disabled' };
  }

  const campaigns = (await listCampaigns()).filter(item => item.status === 'running');
  if (campaigns.length === 0) {
    return { skipped: true, reason: 'no_running_campaigns' };
  }

  logger.info(
    {
      jobId: job.id,
      trigger: job.data?.trigger,
      campaigns: campaigns.map(item => item.id),
    },
    'Coverage planning cycle ready for discovery phase',
  );

  // Phase 1 foundation deliberately stops here. The discovery service will
  // consume these campaign definitions in the next implementation slice.
  return {
    planned: true,
    campaignCount: campaigns.length,
    campaigns: campaigns.map(item => ({
      id: item.id,
      categories: item.categories,
      locations: item.locations,
      target: item.dailyTarget,
      hardLimit: item.dailyHardLimit,
    })),
  };
}

async function pipelineIsDrained(): Promise<boolean> {
  const counts = await getQueueCounts();
  const pipelineKeys = (Object.keys(QUEUE_NAMES) as QueueKey[]).filter(key => key !== 'orchestration');
  return pipelineKeys.every(key => {
    const queue = counts[key] || {};
    return (queue.waiting || 0) + (queue.active || 0) + (queue.delayed || 0) === 0;
  });
}

async function handleReconcile(): Promise<Record<string, unknown>> {
  const settings = await getSettings();
  if (settings.runState === 'draining') {
    await heartbeat('draining');
    if (await pipelineIsDrained()) {
      const updated = await patchSettings({ runState: 'stopped' }, 'system-reconciler');
      await recordAuditEvent('system-reconciler', 'bot.drain_completed');
      await heartbeat('ready');
      return { reconciled: true, drainCompleted: true, runState: updated.runState };
    }
    return { reconciled: true, drainCompleted: false };
  }

  return { reconciled: true, runState: settings.runState };
}

async function processJob(job: Job): Promise<Record<string, unknown>> {
  switch (job.name) {
    case 'coverage-plan':
      return handleCoveragePlan(job);
    case 'system-reconcile':
      return handleReconcile();
    default:
      throw new Error(`Unknown orchestration job: ${job.name}`);
  }
}

async function registerSchedulers(): Promise<void> {
  const queue = getQueue('orchestration');
  await queue.upsertJobScheduler(
    'coverage-planner-v1',
    { every: 6 * 60 * 60 * 1000 },
    {
      name: 'coverage-plan',
      data: { trigger: 'scheduler' },
      opts: { attempts: 1, removeOnComplete: 500, removeOnFail: 500 },
    },
  );
  await queue.upsertJobScheduler(
    'system-reconciler-v1',
    { every: 5 * 60 * 1000 },
    {
      name: 'system-reconcile',
      data: { trigger: 'scheduler' },
      opts: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
    },
  );
}

async function start(): Promise<void> {
  await ensureMongoIndexes();
  await connectRedis();
  await heartbeat('starting');
  await registerSchedulers();

  worker = new Worker(QUEUE_NAMES.orchestration, processJob, {
    connection: getRedis(),
    prefix: env.BOT_QUEUE_NAMESPACE,
    concurrency: 2,
  });

  worker.on('completed', job => {
    logger.info({ jobId: job.id, jobName: job.name }, 'Orchestration job completed');
  });
  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, jobName: job?.name, err: error }, 'Orchestration job failed');
  });
  worker.on('error', error => {
    logger.error({ err: error }, 'Orchestration worker error');
  });

  await heartbeat('ready');
  heartbeatTimer = setInterval(() => {
    void heartbeat('ready').catch(error => logger.error({ err: error }, 'Worker heartbeat failed'));
  }, 30_000);
  heartbeatTimer.unref();

  logger.info({ workerId }, 'Supplier Bot worker ready');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Supplier Bot worker shutting down');
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    await heartbeat('stopping').catch(() => undefined);
    if (worker) {
      await worker.close();
    }
    await closeQueues();
    await closeRedis();
    await closeMongo();
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

start().catch(error => {
  logger.fatal({ err: error }, 'Failed to start Supplier Bot worker');
  process.exit(1);
});
