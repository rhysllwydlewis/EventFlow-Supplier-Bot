import { getQueue, QUEUE_NAMES, type QueueKey } from '../queues/index.js';
import { getSettings, patchSettings, type SettingsPatch } from '../repositories/settings.repository.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import {
  invalidateAllComplianceAssessments,
  withCompliancePolicyLock,
} from '../repositories/compliance-assessment.repository.js';
import { performHardReset } from './hard-reset.service.js';
import { reconcilePhase3Validation } from './phase3-validation.service.js';

const PIPELINE_QUEUE_KEYS = (Object.keys(QUEUE_NAMES) as QueueKey[]).filter(key => key !== 'orchestration');

async function pausePipelineQueues(): Promise<void> {
  await Promise.all(PIPELINE_QUEUE_KEYS.map(key => getQueue(key).pause()));
}

async function resumePipelineQueues(): Promise<void> {
  await Promise.all(PIPELINE_QUEUE_KEYS.map(key => getQueue(key).resume()));
}

export async function playBot(actor: string) {
  await resumePipelineQueues();
  const settings = await patchSettings({ runState: 'running' }, actor);
  try {
    const phase3 = await reconcilePhase3Validation(settings);
    if (
      phase3.report.run &&
      phase3.report.run.status !== 'completed' &&
      !phase3.report.safety.safeToValidate
    ) {
      throw new Error('Phase 3 safety contract is not satisfied');
    }
  } catch (error) {
    await patchSettings(
      {
        mode: 'shadow',
        runState: 'stopped',
        publishingEnabled: false,
        claimNoticesEnabled: false,
        marketingEnabled: false,
        seoIndexingEnabled: false,
      },
      'phase3-validator-fail-closed',
    );
    await pausePipelineQueues();
    await recordAuditEvent('phase3-validator', 'phase3.validation_start_failed', {
      requestedBy: actor,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await recordAuditEvent(actor, 'bot.play', { mode: settings.mode });
  return settings;
}

export async function pauseBot(actor: string) {
  const settings = await patchSettings({ runState: 'paused' }, actor);
  await pausePipelineQueues();
  await recordAuditEvent(actor, 'bot.pause', { queuesPaused: PIPELINE_QUEUE_KEYS });
  return settings;
}

export async function drainBot(actor: string) {
  const settings = await patchSettings({ runState: 'draining' }, actor);
  await recordAuditEvent(actor, 'bot.drain');
  return settings;
}

export async function emergencyStopBot(actor: string) {
  const settings = await patchSettings(
    {
      runState: 'emergency_stopped',
      publishingEnabled: false,
      claimNoticesEnabled: false,
      marketingEnabled: false,
      seoIndexingEnabled: false,
    },
    actor,
  );
  await pausePipelineQueues();
  await recordAuditEvent(actor, 'bot.emergency_stop', { queuesPaused: PIPELINE_QUEUE_KEYS });
  return settings;
}

export async function hardResetBot(actor: string) {
  await pausePipelineQueues();
  const settings = await patchSettings({ runState: 'paused' }, actor);
  const deletedCounts = await performHardReset();
  await recordAuditEvent(actor, 'bot.hard_reset', { deletedCounts });
  return { settings, deletedCounts };
}

export async function updateRuntimeSettings(patch: SettingsPatch, actor: string) {
  return withCompliancePolicyLock(`settings:${actor}`, async () => {
    const before = await getSettings();
    const qualityFloorChanged =
      patch.minimumPublicationQuality !== undefined &&
      patch.minimumPublicationQuality !== before.minimumPublicationQuality;
    let invalidatedCompliance = 0;
    if (qualityFloorChanged) {
      invalidatedCompliance = await invalidateAllComplianceAssessments();
    }

    // Leaving live mode is always fail-safe: publishing is disabled in the
    // same atomic settings update instead of depending on a second UI action.
    // This keeps Control, worker reconciles and direct API callers consistent.
    const effectivePatch: SettingsPatch = {
      ...patch,
      ...(patch.mode !== undefined && patch.mode !== 'live'
        ? { publishingEnabled: false }
        : {}),
    };
    const settings = await patchSettings(effectivePatch, actor);
    await recordAuditEvent(actor, 'settings.update', {
      requestedPatch: patch,
      effectivePatch,
      publishingDisabledByModeTransition:
        patch.mode !== undefined && patch.mode !== 'live' && before.publishingEnabled,
      qualityFloorChanged,
      invalidatedCompliance,
    });
    return settings;
  });
}
