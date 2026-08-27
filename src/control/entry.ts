import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import { ensureMongoIndexes } from '../lib/mongo.js';
import { connectRedis } from '../lib/redis.js';
import { getSettings } from '../repositories/settings.repository.js';
import { bootstrapPhase3Validation } from '../services/phase3-autostart.service.js';
import {
  getPhase3ValidationReport,
  PHASE3_TARGET_CANDIDATES,
} from '../services/phase3-validation.service.js';

const PROGRESS_REFRESH_MS = 5 * 60 * 1000;
const progressPath = path.join(process.cwd(), 'public', 'phase3-progress.json');
const progressTempPath = `${progressPath}.tmp`;

async function writePublicPhase3Progress(): Promise<void> {
  const settings = await getSettings();
  const report = await getPhase3ValidationReport(settings);
  const candidateCount = report.metrics.candidateCount;
  const targetCandidates = report.run?.targetCandidates ?? PHASE3_TARGET_CANDIDATES;
  const status = report.run?.restartRequiredAt
    ? 'restart_required'
    : (report.run?.status ?? 'not_started');

  const payload = {
    phase: 3,
    status,
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

async function start(): Promise<void> {
  await ensureMongoIndexes();
  await connectRedis();

  try {
    const result = await bootstrapPhase3Validation();
    logger.info({ phase3Autostart: result }, 'Phase 3 autonomous bootstrap evaluated');
  } catch (error) {
    // Keep the Control Centre available for diagnosis. The bootstrap itself is
    // fail-closed and never weakens Pause/Emergency Stop or outbound controls.
    logger.error({ err: error }, 'Phase 3 autonomous bootstrap failed');
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

  await import('./server.js');
}

start().catch(error => {
  logger.fatal({ err: error }, 'Failed to start Supplier Bot control entrypoint');
  process.exit(1);
});
