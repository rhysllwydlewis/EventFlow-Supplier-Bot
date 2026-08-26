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
  countCandidatesSince,
  getCandidate,
  setCandidateStatus,
} from '../repositories/candidate.repository.js';
import { writeHeartbeat } from '../repositories/heartbeat.repository.js';
import { getSettings, patchSettings } from '../repositories/settings.repository.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import { isSuppressed } from '../repositories/suppression.repository.js';
import { tryClaimDailyBrowserCrawlSlot } from '../services/browser-crawl-budget.service.js';
import { enqueueBrowserCrawlCandidate, reconcileQueuedBrowserCrawlCandidates } from '../services/browser-crawl-queue.service.js';
import { tryClaimDailyCrawlSlot } from '../services/crawl-budget.service.js';
import { enqueueCrawlCandidate, reconcileQueuedCrawlCandidates } from '../services/crawl-queue.service.js';
import { reassessPendingCompliance } from '../services/compliance-reassessment.service.js';
import { remainingDailyAllowance } from '../services/daily-limit.service.js';
import { runDiscoveryCycle } from '../services/discovery.service.js';
import { reconcileEventFlowPublicationQueue } from '../services/eventflow-publication-queue.service.js';
import { processEventFlowPublication } from '../services/eventflow-publication.service.js';
import {
  completePhase3ValidationRun,
  reconcilePhase3Validation,
} from '../services/phase3-validation.service.js';
import { runBrowserShadowPipeline, runShadowPipeline } from '../services/shadow-pipeline.service.js';

const VERSION = '0.8.0';
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
  if (campaigns.length === 0) return { skipped: true, reason: 'no_running_campaigns' };
  const dayStart = startOfUtcDayIso();
  const globalAcquiredToday = await countCandidatesSince(dayStart);
  const scheduled: Array<{ campaignId: string; remainingAllowance: number }> = [];
  for (const campaign of campaigns) {
    const campaignAcquiredToday = await countCampaignCandidatesSince(campaign.id, dayStart);
    const remainingAllowance = remainingDailyAllowance(
      campaignAcquiredToday,
      globalAcquiredToday,
      campaign.dailyHardLimit,
      settings.dailyHardLimit,
    );
    if (remainingAllowance === 0) continue;
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
  const dayStart = startOfUtcDayIso();
  const [campaignAcquiredToday, globalAcquiredToday] = await Promise.all([
    countCampaignCandidatesSince(campaign.id, dayStart),
    countCandidatesSince(dayStart),
  ]);
  const remainingAllowance = remainingDailyAllowance(
    campaignAcquiredToday,
    globalAcquiredToday,
    campaign.dailyHardLimit,
    settings.dailyHardLimit,
  );
  if (remainingAllowance === 0) return { skipped: true, reason: 'daily_hard_limit_reached' };
  const provider = typeof job.data?.provider === 'string' ? job.data.provider : 'brave';
  const requestedAllowance = Number(job.data?.remainingAllowance);
  const allowance = Number.isFinite(requestedAllowance)
    ? Math.min(remainingAllowance, Math.max(0, Math.floor(requestedAllowance)))
    : remainingAllowance;
  const result = await runDiscoveryCycle(campaign, provider, allowance, settings.dailyHardLimit);
  let crawlJobsQueued = 0;
  for (const candidateId of result.candidateIdsCreated) {
    await setCandidateStatus(candidateId, 'queued_for_crawl');
    if (await enqueueCrawlCandidate(candidateId, 'discovery')) crawlJobsQueued += 1;
  }
  return { ...result, crawlJobsQueued };
}

async function getRunnableCandidate(job: Job, actor: string) {
  const candidateId = typeof job.data?.candidateId === 'string' ? job.data.candidateId : '';
  const candidate = candidateId ? await getCandidate(candidateId) : null;
  if (!candidate) throw new Error('Crawl candidate not found');
  if (await isSuppressed(candidate.canonicalDomain, 'do_not_crawl')) {
    await setCandidateStatus(candidate.id, 'suppressed');
    await recordAuditEvent(actor, 'candidate.suppressed_before_crawl', {
      candidateId: candidate.id,
      domain: candidate.canonicalDomain,
    });
    return null;
  }
  return candidate;
}

async function handleCrawlJob(job: Job): Promise<Record<string, unknown>> {
  const settings = await getSettings();
  if (settings.runState === 'emergency_stopped' || settings.mode === 'off') {
    return { skipped: true, reason: 'bot_stopped' };
  }
  const candidate = await getRunnableCandidate(job, 'crawl-worker');
  if (!candidate) return { skipped: true, reason: 'do_not_crawl_suppression' };
  const claimed = await tryClaimDailyCrawlSlot(
    settings.maxCrawlsPerDay,
    env.ABSOLUTE_MAX_CRAWLS_PER_DAY,
  );
  if (!claimed) {
    await setCandidateStatus(candidate.id, 'queued_for_crawl');
    return { skipped: true, reason: 'crawl_daily_limit_reached', retryNextUtcDay: true };
  }
  const result = await runShadowPipeline(candidate);
  if ('browserFallbackRequired' in result && result.browserFallbackRequired) {
    await setCandidateStatus(candidate.id, 'queued_for_browser_crawl');
    const queued = await enqueueBrowserCrawlCandidate(candidate.id, 'static-fallback');
    return { ...result, browserJobQueued: queued };
  }
  return result;
}

async function handleBrowserCrawlJob(job: Job): Promise<Record<string, unknown>> {
  const settings = await getSettings();
  if (settings.runState === 'emergency_stopped' || settings.mode === 'off') {
    return { skipped: true, reason: 'bot_stopped' };
  }
  const candidate = await getRunnableCandidate(job, 'browser-crawl-worker');
  if (!candidate) return { skipped: true, reason: 'do_not_crawl_suppression' };
  const claimed = await tryClaimDailyBrowserCrawlSlot(env.ABSOLUTE_MAX_BROWSER_CRAWLS_PER_DAY);
  if (!claimed) {
    await setCandidateStatus(candidate.id, 'queued_for_browser_crawl');
    return { skipped: true, reason: 'browser_crawl_daily_limit_reached', retryNextUtcDay: true };
  }
  return runBrowserShadowPipeline(candidate);
}

async function handlePublicationJob(job: Job): Promise<Record<string, unknown>> {
  const candidateId = typeof job.data?.candidateId === 'string' ? job.data.candidateId : '';
  if (!candidateId) throw new Error('Publication candidate id is required');
  return processEventFlowPublication(candidateId);
}

async function pipelineIsDrained(): Promise<boolean> {
  const counts = await getQueueCounts();
  const pipelineKeys = (Object.keys(QUEUE_NAMES) as QueueKey[]).filter(
    key => key !== 'orchestration',
  );
  return pipelineKeys.every(key => {
    const queue = counts[key] || {};
    return (queue.waiting || 0) + (queue.active || 0) + (queue.delayed || 0) === 0;
  });
}

async function handleReconcile(): Promise<Record<string, unknown>> {
  const initialSettings = await getSettings();
  const phase3 = await reconcilePhase3Validation(initialSettings);
  const settings = phase3.transitionedToDraining ? await getSettings() : initialSettings;
  const reassessedCompliance = await reassessPendingCompliance(100);
  const mayRecoverQueuedWork =
    settings.mode !== 'off' &&
    (settings.runState === 'running' || settings.runState === 'paused');
  const [recoveredCrawls, recoveredBrowserCrawls] = mayRecoverQueuedWork
    ? await Promise.all([reconcileQueuedCrawlCandidates(), reconcileQueuedBrowserCrawlCandidates()])
    : [0, 0];
  const recoveredPublications =
    settings.mode !== 'off' &&
    settings.runState !== 'emergency_stopped' &&
    settings.publishingEnabled
      ? await reconcileEventFlowPublicationQueue(100)
      : 0;

  if (settings.runState === 'draining') {
    await heartbeat('draining');
    if (await pipelineIsDrained()) {
      const updated = await patchSettings({ runState: 'stopped' }, 'system-reconciler');
      await recordAuditEvent('system-reconciler', 'bot.drain_completed');
      await completePhase3ValidationRun();
      await heartbeat('ready');
      return {
        reconciled: true,
        drainCompleted: true,
        runState: updated.runState,
        recoveredCrawls,
        recoveredBrowserCrawls,
        recoveredPublications,
        reassessedCompliance,
        phase3,
      };
    }
    return {
      reconciled: true,
      drainCompleted: false,
      recoveredCrawls,
      recoveredBrowserCrawls,
      recoveredPublications,
      reassessedCompliance,
      phase3,
    };
  }

  return {
    reconciled: true,
    runState: settings.runState,
    recoveredCrawls,
    recoveredBrowserCrawls,
    recoveredPublications,
    reassessedCompliance,
    phase3,
  };
}

async function processOrchestrationJob(job: Job): Promise<Record<string, unknown>> {
  if (job.name === 'coverage-plan') return handleCoveragePlan(job);
  if (job.name === 'system-reconcile') return handleReconcile();
  throw new Error(`Unknown orchestration job: ${job.name}`);
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
  worker.on('completed', job =>
    logger.info(
      { queue: label, jobId: job.id, jobName: job.name },
      'Supplier Bot job completed',
    ),
  );
  worker.on('failed', (job, error) =>
    logger.error(
      { queue: label, jobId: job?.id, jobName: job?.name, err: error },
      'Supplier Bot job failed',
    ),
  );
  worker.on('error', error => logger.error({ queue: label, err: error }, 'Supplier Bot worker error'));
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
  const crawl = new Worker(QUEUE_NAMES.crawl, handleCrawlJob, { ...shared, concurrency: 2 });
  const browserCrawl = new Worker(QUEUE_NAMES.browserCrawl, handleBrowserCrawlJob, {
    ...shared,
    concurrency: 1,
  });
  const publication = new Worker(QUEUE_NAMES.publication, handlePublicationJob, {
    ...shared,
    concurrency: 1,
  });
  workers.push(orchestration, discovery, crawl, browserCrawl, publication);
  attachWorkerLogging(orchestration, 'orchestration');
  attachWorkerLogging(discovery, 'discovery');
  attachWorkerLogging(crawl, 'crawl');
  attachWorkerLogging(browserCrawl, 'browser-crawl');
  attachWorkerLogging(publication, 'publication');
}

async function start(): Promise<void> {
  await ensureMongoIndexes();
  await connectRedis();
  await heartbeat('starting');
  await registerSchedulers();
  startWorkers();
  await heartbeat('ready');
  heartbeatTimer = setInterval(
    () => void heartbeat('ready').catch(error => logger.error({ err: error }, 'Worker heartbeat failed')),
    30_000,
  );
  heartbeatTimer.unref();
  logger.info({ workerId, workers: workers.length }, 'Supplier Bot workers ready');
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Supplier Bot worker process shutting down');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
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
