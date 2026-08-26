import { getQueue, QUEUE_NAMES, type QueueKey } from '../queues/index.js';
import { getSettings, patchSettings, type SettingsPatch } from '../repositories/settings.repository.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import {
  invalidateAllComplianceAssessments,
  withCompliancePolicyLock,
} from '../repositories/compliance-assessment.repository.js';

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
      marketingEnabled: false,
      seoIndexingEnabled: false,
    },
    actor,
  );
  await pausePipelineQueues();
  await recordAuditEvent(actor, 'bot.emergency_stop', { queuesPaused: PIPELINE_QUEUE_KEYS });
  return settings;
}

export async function updateRuntimeSettings(patch: SettingsPatch, actor: string) {
  return withCompliancePolicyLock(`settings:${actor}`, async () => {
    const before = await getSettings();
    const qualityFloorChanged = patch.minimumPublicationQuality !== undefined
      && patch.minimumPublicationQuality !== before.minimumPublicationQuality;
    let invalidatedCompliance = 0;
    if (qualityFloorChanged) {
      invalidatedCompliance = await invalidateAllComplianceAssessments();
    }
    const settings = await patchSettings(patch, actor);
    await recordAuditEvent(actor, 'settings.update', {
      patch,
      qualityFloorChanged,
      invalidatedCompliance,
    });
    return settings;
  });
}
