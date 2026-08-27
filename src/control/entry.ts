import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import { ensureMongoIndexes } from '../lib/mongo.js';
import { connectRedis } from '../lib/redis.js';
import {
  getDiscoveryQueueDiagnostic,
  getQueue,
  type DiscoveryCompletionDiagnostic,
  type QueueFailureDiagnostic,
} from '../queues/index.js';
import { heartbeatIsFresh, listHeartbeats } from '../repositories/heartbeat.repository.js';
import { getSettings } from '../repositories/settings.repository.js';
import { bootstrapPhase3Validation } from '../services/phase3-autostart.service.js';
import { applyPhase3DiscoveryQualityRevision } from '../services/phase3-discovery-quality-revision.service.js';
import {
  getPhase3ValidationReport,
  PHASE3_TARGET_CANDIDATES,
} from '../services/phase3-validation.service.js';

const PROGRESS_REFRESH_MS = 5 * 60 * 1000;
const PHASE3_RECOVERY_INTERVAL_MS = 30 * 60 * 1000;
const progressPath = path.join(process.cwd(), 'public', 'phase3-progress.json');
const progressTempPath = `${progressPath}.tmp`;
const NON_RETRYABLE_DISCOVERY_FAILURES = new Set([
  'brave_not_configured',
  'brave_http_400',
  'brave_http_401',
  'brave_http_402',
  'brave_http_403',
]);
let autostartOutcome: { started: boolean; reason: string; campaignId?: string } | null = null;

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function happenedDuringRun(
  diagnostic: { occurredAt: string | null } | null,
  startedAt: string | null | undefined,
): boolean {
  const diagnosticAt = timestampMs(diagnostic?.occurredAt);
  const runStart = timestampMs(startedAt);
  return diagnosticAt !== null && runStart !== null && diagnosticAt >= runStart;
}

function unresolvedCurrentRunFailure(input: {
  failure: QueueFailureDiagnostic | null;
  completion: DiscoveryCompletionDiagnostic | null;
  startedAt: string | null | undefined;
}): QueueFailureDiagnostic | null {
  const { failure, completion, startedAt } = input;
  if (!happenedDuringRun(failure, startedAt)) return null;
  const failureAt = timestampMs(failure?.occurredAt);
  const completionAt = happenedDuringRun(completion, startedAt)
    ? timestampMs(completion?.occurredAt)
    : null;
  return failureAt !== null && (completionAt === null || failureAt > completionAt) ? failure : null;
}

async function writePublicPhase3Progress(): Promise<void> {
  const settings = await getSettings();
  const [report, discovery] = await Promise.all([
    getPhase3ValidationReport(settings),
    getDiscoveryQueueDiagnostic(),
  ]);
  const candidateCount = report.metrics.candidateCount;
  const targetCandidates = report.run?.targetCandidates ?? PHASE3_TARGET_CANDIDATES;
  const status = report.run?.restartRequiredAt
    ? 'restart_required'
    : (report.run?.status ?? 'not_started');
  const latestFailure = happenedDuringRun(discovery.latestFailure, report.run?.startedAt)
    ? discovery.latestFailure
    : null;
  const latestCompletion = happenedDuringRun(discovery.latestCompletion, report.run?.startedAt)
    ? discovery.latestCompletion
    : null;

  const payload = {
    phase: 3,
    status,
    autostart: autostartOutcome,
    startedAt: report.run?.startedAt ?? null,
    completedAt: report.run?.completedAt ?? null,
    candidateCount,
    targetCandidates,
    progressPct:
      targetCandidates > 0
        ? Math.min(100, Math.round((candidateCount / targetCandidates) * 1000) / 10)
        : 0,
    targetReached: report.targetReached,
    readyForReview: report.readyForReview,
    safetyHealthy: report.safety.safeToValidate,
    discovery: {
      queue: discovery.counts,
      latestFailure,
      latestCompletion,
    },
    metrics: {
      shadowProfileCount: report.metrics.shadowProfileCount,
      profileYieldPct: report.metrics.profileYieldPct,
      averagePublicationQuality: report.metrics.averagePublicationQuality,
      averageDataConfidence: report.metrics.averageDataConfidence,
      evidenceCoveragePct: report.metrics.evidenceCoveragePct,
      advertisedPriceCoveragePct: report.metrics.advertisedPriceCoveragePct,
      packageCoveragePct: report.metrics.packageCoveragePct,
      distinctCandidates: report.metrics.distinctCandidates,
      probableDuplicates: report.metrics.probableDuplicates,
      strongDuplicates: report.metrics.strongDuplicates,
      quarantinedCandidates: report.metrics.quarantinedCandidates,
      rejectedCandidates: report.metrics.rejectedCandidates,
      publicationEligible: report.metrics.publicationEligible,
      complianceReview: report.metrics.complianceReview,
      complianceBlocked: report.metrics.complianceBlocked,
      aiEstimatedCostGbp: report.metrics.aiEstimatedCostGbp,
      aiCostPerCandidateGbp: report.metrics.aiCostPerCandidateGbp,
    },
    updatedAt: new Date().toISOString(),
  };

  // Rename keeps readers from observing a partially-written JSON document.
  await writeFile(progressTempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(progressTempPath, progressPath);
}

async function schedulePhase3RecoveryPlanning(trigger: string): Promise<void> {
  const settings = await getSettings();
  if (
    settings.runState !== 'running' ||
    settings.mode !== 'shadow' ||
    !settings.discoveryEnabled
  ) {
    return;
  }

  const [report, discovery, heartbeats] = await Promise.all([
    getPhase3ValidationReport(settings),
    getDiscoveryQueueDiagnostic(),
    listHeartbeats(),
  ]);
  if (
    !report.run ||
    report.run.status !== 'collecting' ||
    report.run.restartRequiredAt ||
    report.targetReached ||
    !report.safety.safeToValidate
  ) {
    return;
  }

  const pendingDiscovery =
    discovery.counts.waiting + discovery.counts.active + discovery.counts.delayed;
  if (pendingDiscovery > 0) return;

  const unresolvedFailure = unresolvedCurrentRunFailure({
    failure: discovery.latestFailure,
    completion: discovery.latestCompletion,
    startedAt: report.run.startedAt,
  });
  const failureAt = timestampMs(unresolvedFailure?.occurredAt);
  const workerRestartedAfterFailure =
    failureAt !== null &&
    heartbeats.some(
      item =>
        item.processType === 'worker' &&
        item.status === 'ready' &&
        heartbeatIsFresh(item) &&
        (timestampMs(item.startedAt) ?? 0) > failureAt,
    );

  if (
    unresolvedFailure &&
    NON_RETRYABLE_DISCOVERY_FAILURES.has(unresolvedFailure.code) &&
    !workerRestartedAfterFailure
  ) {
    logger.error(
      { code: unresolvedFailure.code, occurredAt: unresolvedFailure.occurredAt },
      'Phase 3 discovery recovery halted on non-retryable provider failure',
    );
    return;
  }

  if (unresolvedFailure && workerRestartedAfterFailure) {
    logger.info(
      { code: unresolvedFailure.code, occurredAt: unresolvedFailure.occurredAt },
      'Phase 3 discovery failure predates current worker; allowing one recovery probe',
    );
  }

  const latestActivityAt = Math.max(
    timestampMs(discovery.latestFailure?.occurredAt) ?? 0,
    timestampMs(discovery.latestCompletion?.occurredAt) ?? 0,
  );
  if (
    latestActivityAt > 0 &&
    Date.now() - latestActivityAt < PHASE3_RECOVERY_INTERVAL_MS &&
    !unresolvedFailure
  ) {
    return;
  }

  const recoveryBucket = Math.floor(Date.now() / PHASE3_RECOVERY_INTERVAL_MS);
  await getQueue('orchestration').add(
    'coverage-plan',
    { trigger, requestedAt: new Date().toISOString() },
    {
      jobId: `phase3-recovery-plan-${recoveryBucket}`,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );
  logger.info({ trigger, recoveryBucket }, 'Phase 3 discovery recovery planning queued');
}

async function start(): Promise<void> {
  await ensureMongoIndexes();
  await connectRedis();

  try {
    autostartOutcome = await bootstrapPhase3Validation();
    logger.info({ phase3Autostart: autostartOutcome }, 'Phase 3 autonomous bootstrap evaluated');
  } catch (error) {
    // Keep the Control Centre available for diagnosis. The bootstrap itself is
    // fail-closed and never weakens Pause/Emergency Stop or outbound controls.
    autostartOutcome = { started: false, reason: 'bootstrap_error' };
    logger.error({ err: error }, 'Phase 3 autonomous bootstrap failed');
  }

  await applyPhase3DiscoveryQualityRevision()
    .then(outcome => {
      if (outcome.reset) {
        logger.warn(
          { revision: outcome.revision },
          'Phase 3 validation window reset after discovery supplier-quality hardening',
        );
      }
    })
    .catch(error =>
      logger.error({ err: error }, 'Failed to apply Phase 3 discovery quality revision'),
    );

  // A fresh autostart already queues its own immediate coverage plan. On a
  // restart of an existing Phase 3 run, recover an idle/retryable discovery
  // pipeline immediately instead of waiting for the six-hour normal planner.
  if (!autostartOutcome?.started) {
    await schedulePhase3RecoveryPlanning('phase3-recovery-startup').catch(error =>
      logger.error({ err: error }, 'Phase 3 startup recovery planning failed'),
    );
  }

  await writePublicPhase3Progress().catch(error =>
    logger.error({ err: error }, 'Failed to write public Phase 3 progress'),
  );
  const progressTimer = setInterval(() => {
    void writePublicPhase3Progress().catch(error =>
      logger.error({ err: error }, 'Failed to refresh public Phase 3 progress'),
    );
  }, PROGRESS_REFRESH_MS);
  progressTimer.unref();

  const recoveryTimer = setInterval(() => {
    void schedulePhase3RecoveryPlanning('phase3-recovery-watchdog').catch(error =>
      logger.error({ err: error }, 'Phase 3 recovery watchdog failed'),
    );
  }, PHASE3_RECOVERY_INTERVAL_MS);
  recoveryTimer.unref();

  await import('./server.js');
}

start().catch(error => {
  logger.fatal({ err: error }, 'Failed to start Supplier Bot control entrypoint');
  process.exit(1);
});
