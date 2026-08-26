import { hostname } from 'node:os';
import { Worker, type Job } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { closeMongo, ensureMongoIndexes } from '../lib/mongo.js';
import { closeRedis, connectRedis, getRedis } from '../lib/redis.js';
import { closeQueues, getQueue, getQueueCounts, QUEUE_NAMES, type QueueKey } from '../queues/index.js';
import { getCampaign, listCampaigns } from '../repositories/campaign.repository.js';
import {
  countCampaignCandidatesSince,
  getCandidate,
  setCandidateStatus,
} from '../repositories/candidate.repository.js';
import { writeHeartbeat } from '../repositories/heartbeat.repository.js';
import { getSettings, patchSettings } from '../repositories/settings.repository.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import { remainingDailyAllowance } from '../services/daily-limit.service.js';
import { runDiscoveryCycle } from '../services/discovery.service.js';
import { runShadowPipeline } from '../services/shadow-pipeline.service.js';

const VERSION = '0.2.0';
const workerId = `worker-${hostname()}-${process.pid}`;
const startedAt = new Date().toISOString();
let heartbeatTimer: NodeJS.Timeout | null = null;
const workers: Worker[] = [];

function startOfUtcDayIso(): string {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  return value.toISOString();
}

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

  const dayStart = startOfUtcDayIso();
  const scheduled: Array<{ campaignId: string; remainingAllowance: number }> = [];
  for (const campaign of campaigns) {
    const acquiredToday = await countCampaignCandidatesSince(campaign.id, dayStart);
    const remainingAllowance = remainingDailyAllowance(
      acquiredToday,
      campaign.dailyHardLimit,
      settings.dailyHardLimit,
    );
    if (remainingAllowance === 0) {
      continue;
    }

    await getQueue('discovery').add(
      'discover-campaign',
      {
        campaignId: campaign.id,
        provider: 'brave',
        remainingAllowance,
        trigger: job.data?.trigger || 'orchestration',
      },
      {
        jobId: `discover-${campaign.id}-${Date.now()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      },
    );
    scheduled.push({ campaignId: campaign.id, remainingAllowance });
  }

  logger.info({ jobId: job.id, scheduled }, 'Coverage planning cycle queued discovery work');
  return { planned: true, campaignCount: campaigns.length, scheduled };
}

async function handleDiscoveryJob(job: Job): Promise<Record<string, unknown>> {
  const settings = await getSettings();
  if (settings.runState !== 'running' || !settings.discoveryEnabled || settings.mode === 'off') {
    return { skipped: true, reason: 'discovery_not_running' };
  }

  const campaignId = typeof job.data?.campaignId === 'string' ? job.data.campaignId : '';
  const campaign = campaignId ? await getCampaign(campaignId) : null;
  if (!campaign || campaign.status !== 'running') {
    return { skipped: true, reason: 'campaign_not_running' };
  }

  const acquiredToday = await countCampaignCandidatesSince(campaign.id, startOfUtcDayIso());
  const remainingAllowance = remainingDailyAllowance(
    acquiredToday,
    campaign.dailyHardLimit,
    settings.dailyHardLimit,
  );
  if (remainingAllowance === 0) {
    return { skipped: true, reason: 'daily_hard_limit_reached' };
  }

  const provider = typeof job.data?.provider === 'string' ? job.data.provider : 'brave';
  const requestedAllowance = Number(job.data?.remainingAllowance);
  const allowance = Number.isFinite(requestedAllowance)
    ? Math.min(remainingAllowance, Math.max(0, Math.floor(requestedAllowance)))
    : remainingAllowance;
  const result = await runDiscoveryCycle(campaign, provider, allowance);

  for (const candidateId of result.candidateIdsCreated) {
    await setCandidateStatus(candidateId, 'queued_for_crawl');
    await getQueue('crawl').add(
      'crawl-candidate',
      { candidateId, trigger: 'discovery' },
      {
        jobId: `crawl-${candidateId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      },
    );
  }

  return { ...result, crawlJobsQueued: result.candidateIdsCreated.length };
}

async function handleCrawlJob(job: Job): Promise<Record<string, unknown>> {
  const settings = await getSettings();
  if (settings.runState === 'emergency_stopped' || settings.mode === 'off') {
    return { skipped: true, reason: 'bot_stopped' };
  }

  const candidateId = typeof job.data?.candidateId === 'string' ? job.data.candidateId : '';
  const candidate = candidateId ? await getCandidate(candidateId) : null;
  if (!candidate) {
    throw new Error('Crawl candidate not found');
  }

  return runShadowPipeline(candidate);
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

async function processOrchestrationJob(job: Job): Promise<Record<string, unknown>> {
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

function attachWorkerLogging(worker: Worker, label: string): void {
  worker.on('completed', job => {
    logger.info({ queue: label, jobId: job.id, jobName: job.name }, 'Supplier Bot job completed');
  });
  worker.on('failed', (job, error) => {
    logger.error({ queue: label, jobId: job?.id, jobName: job?.name, err: error }, 'Supplier Bot job failed');
  });
  worker.on('error', error => {
    logger.error({ queue: label, err: error }, 'Supplier Bot worker error');
  });
}

function startWorkers(): void {
  const shared = { connection: getRedis(), prefix: env.BOT_QUEUE_NAMESPACE };
  const orchestration = new Worker(QUEUE_NAMES.orchestration, processOrchestrationJob, {
    ...shared,
    concurrency: 2,
  });
  const discovery = new Worker(QUEUE_NAMES.discovery, handleDiscoveryJob, {
    ...shared,
    concurrency: 1,
  });
  const crawl = new Worker(QUEUE_NAMES.crawl, handleCrawlJob, {
    ...shared,
    concurrency: 2,
  });
  workers.push(orchestration, discovery, crawl);
  attachWorkerLogging(orchestration, 'orchestration');
  attachWorkerLogging(discovery, 'discovery');
  attachWorkerLogging(crawl, 'crawl');
}

async function start(): Promise<void> {
  await ensureMongoIndexes();
  await connectRedis();
  await heartbeat('starting');
  await registerSchedulers();
  startWorkers();

  await heartbeat('ready');
  heartbeatTimer = setInterval(() => {
    void heartbeat('ready').catch(error => logger.error({ err: error }, 'Worker heartbeat failed'));
  }, 30_000);
  heartbeatTimer.unref();

  logger.info({ workerId, workers: workers.length }, 'Supplier Bot workers ready');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Supplier Bot worker process shutting down');
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    await heartbeat('stopping').catch(() => undefined);
    await Promise.all(workers.map(item => item.close()));
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
