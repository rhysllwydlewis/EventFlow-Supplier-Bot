import { env } from '../config/env.js';
import type { CampaignStatus } from '../domain/campaign.js';
import type { BotSettings } from '../domain/settings.js';
import { getQueue } from '../queues/index.js';
import {
  ensurePilotCampaign,
  updateCampaign,
} from '../repositories/campaign.repository.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import { getSettings, patchSettings } from '../repositories/settings.repository.js';
import {
  getPhase3ValidationReport,
  phase3Safety,
  type Phase3ValidationReport,
} from './phase3-validation.service.js';
import { playBot } from './runtime-control.service.js';

export interface Phase3AutostartCapabilities {
  braveConfigured: boolean;
  bravePersistenceAllowed: boolean;
  openAiConfigured: boolean;
}

export interface Phase3AutostartDecision {
  eligible: boolean;
  reason:
    | 'eligible'
    | 'completed'
    | 'existing_run'
    | 'operator_state'
    | 'unsafe_controls'
    | 'pipeline_disabled'
    | 'provider_not_ready'
    | 'campaign_state';
}

export function phase3AutostartCapabilities(): Phase3AutostartCapabilities {
  return {
    braveConfigured: Boolean(env.BRAVE_API_KEY),
    bravePersistenceAllowed: env.BRAVE_PERSISTENCE_ALLOWED,
    openAiConfigured: Boolean(env.OPENAI_API_KEY),
  };
}

export function phase3AutostartDecision(input: {
  settings: BotSettings;
  report: Phase3ValidationReport;
  capabilities: Phase3AutostartCapabilities;
  pilotStatus: CampaignStatus;
}): Phase3AutostartDecision {
  const { settings, report, capabilities, pilotStatus } = input;
  if (report.run?.status === 'completed') return { eligible: false, reason: 'completed' };
  if (report.run) return { eligible: false, reason: 'existing_run' };
  // Never override an operator pause, drain or emergency stop. Autostart exists
  // only to remove the initial manual Run click from a fresh Phase 3 deployment.
  if (settings.runState !== 'stopped') return { eligible: false, reason: 'operator_state' };
  if (!phase3Safety(settings).safeToValidate) return { eligible: false, reason: 'unsafe_controls' };
  if (!settings.discoveryEnabled || !settings.refreshEnabled) {
    return { eligible: false, reason: 'pipeline_disabled' };
  }
  if (
    !capabilities.braveConfigured ||
    !capabilities.bravePersistenceAllowed ||
    !capabilities.openAiConfigured
  ) {
    return { eligible: false, reason: 'provider_not_ready' };
  }
  if (pilotStatus !== 'draft' && pilotStatus !== 'running') {
    return { eligible: false, reason: 'campaign_state' };
  }
  return { eligible: true, reason: 'eligible' };
}

export async function bootstrapPhase3Validation(): Promise<{
  started: boolean;
  reason: Phase3AutostartDecision['reason'];
  campaignId?: string;
}> {
  const settings = await getSettings();
  const report = await getPhase3ValidationReport(settings);
  const pilot = await ensurePilotCampaign();
  const capabilities = phase3AutostartCapabilities();
  const decision = phase3AutostartDecision({
    settings,
    report,
    capabilities,
    pilotStatus: pilot.status,
  });

  if (!decision.eligible) {
    await recordAuditEvent('phase3-autostart', 'phase3.autostart_skipped', {
      reason: decision.reason,
      runStatus: report.run?.status ?? null,
      runState: settings.runState,
      pilotStatus: pilot.status,
      safetyHealthy: report.safety.safeToValidate,
      capabilities,
    });
    return { started: false, reason: decision.reason };
  }

  // Only a pristine draft is promoted automatically. A paused/completed/
  // archived campaign is an operator decision and is never overridden here.
  const runningPilot =
    pilot.status === 'draft'
      ? await updateCampaign(pilot.id, { status: 'running' })
      : pilot;

  await patchSettings({ activeCampaignId: runningPilot.id }, 'phase3-autostart');
  await playBot('phase3-autostart');

  // Do not wait for the six-hour coverage scheduler after a deploy. The normal
  // daily/campaign hard-limit code still determines how much work is admitted.
  await getQueue('orchestration').add(
    'coverage-plan',
    { trigger: 'phase3-autostart', requestedAt: new Date().toISOString() },
    { jobId: `phase3-autostart-${Date.now()}`, attempts: 1 },
  );

  await recordAuditEvent('phase3-autostart', 'phase3.autostart_started', {
    campaignId: runningPilot.id,
    dailyHardLimit: settings.dailyHardLimit,
    targetCandidates: report.run?.targetCandidates ?? 100,
  });
  return { started: true, reason: 'eligible', campaignId: runningPilot.id };
}
