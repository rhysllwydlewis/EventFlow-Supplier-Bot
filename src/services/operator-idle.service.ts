import type { Campaign } from '../domain/campaign.js';
import type { BotSettings, RunState } from '../domain/settings.js';
import { findLatestAuditEvent } from '../repositories/audit.repository.js';
import { ensurePilotCampaign } from '../repositories/campaign.repository.js';
import {
  phase3AutostartCapabilities,
  phase3AutostartDecision,
  type Phase3AutostartCapabilities,
  type Phase3AutostartDecision,
} from './phase3-autostart.service.js';
import {
  getPhase3ValidationReport,
  type Phase3ValidationReport,
  type Phase3ValidationStatus,
} from './phase3-validation.service.js';

// An operator action (or an automatic safety/lifecycle transition) that takes
// the bot out of 'running'. Anything not in this list either can't move
// runState away from 'running' or, like 'bot.play' itself, would mean the bot
// is 'running' again -- so it would never win the "most recent" comparison
// below while the bot is actually idle.
const STATE_CHANGE_AWAY_FROM_RUNNING_ACTIONS = [
  'bot.pause',
  'bot.drain',
  'bot.emergency_stop',
  'bot.hard_reset',
  'bot.drain_completed',
  'phase3.validation_target_reached',
  'phase3.validation_start_failed',
  'phase3.validation_invalidated',
] as const;

// settingsPatchSchema (control/server.ts) is derived from the full settings
// schema and doesn't omit runState, so a direct PUT /api/settings can also
// move runState away from 'running' -- bypassing pauseBot/drainBot/etc and
// recording a plain 'settings.update' event instead of one of the actions
// above. Without this, such a change would be invisible to idle detection:
// 'since'/'cause' would fall back to whatever tracked event happened to be
// last, or null.
const RUN_STATE_CHANGE_FILTER = {
  $or: [
    { action: { $in: STATE_CHANGE_AWAY_FROM_RUNNING_ACTIONS } },
    { action: 'settings.update', 'details.effectivePatch.runState': { $exists: true } },
  ],
};

// How long the bot can sit idle-but-resumable before it's worth flagging
// rather than treating as a normal operator pause.
export const OPERATOR_IDLE_ALERT_THRESHOLD_MS = 6 * 60 * 60 * 1000;

export type OperatorIdleBlockedReason = Phase3AutostartDecision['reason'] | 'mode_off';

export interface OperatorIdleStatus {
  idle: boolean;
  runState: RunState;
  since: string | null;
  idleSeconds: number | null;
  cause: string | null;
  causedBy: string | null;
  phase3Status: Phase3ValidationStatus | 'not_started';
  awaitingReview: boolean;
  readyToResume: boolean;
  blockedReason: OperatorIdleBlockedReason | null;
  alert: boolean;
}

// phase3AutostartDecision (and the phase3Safety() it calls) hard-requires
// settings.mode === 'shadow' -- it exists to gate the one-time Phase 3
// validation batch, not to answer "would resuming the bot do anything
// useful" in general. Reusing it unconditionally meant readyToResume was
// structurally false forever the moment an operator moved to 'live' (the
// mode this bot is actually meant to run in day to day): phase3Safety()
// would report shadowMode:false, decision.eligible would never be true, and
// no Phase3ValidationRun document exists outside Shadow mode either, so the
// 'existing_run' escape hatch never applies. Confirmed against production:
// the live dashboard reported readyToResume:false with blockedReason
// 'unsafe_controls' while running normally in live mode with nothing wrong.
function computeReadyToResume(input: {
  settings: BotSettings;
  report: Phase3ValidationReport;
  capabilities: Phase3AutostartCapabilities;
  pilotStatus: Campaign['status'];
}): { ready: boolean; blockedReason: OperatorIdleBlockedReason | null } {
  const { settings, report, capabilities, pilotStatus } = input;

  if (settings.mode === 'shadow') {
    // Phase 3's own validation contract is exactly the right authority here
    // -- this is the regime it was built to gate.
    const decision = phase3AutostartDecision({
      settings: { ...settings, runState: 'stopped' },
      report,
      capabilities,
      pilotStatus,
    });
    const ready = decision.eligible || decision.reason === 'existing_run';
    return { ready, blockedReason: ready ? null : decision.reason };
  }

  // Outside Shadow mode there is no Phase 3 contract to satisfy. Resuming is
  // worthwhile as long as the mode itself isn't 'off', and, when discovery
  // is turned on, the providers it depends on are actually configured --
  // otherwise resuming would just spin without finding anything new.
  if (settings.mode === 'off') return { ready: false, blockedReason: 'mode_off' };
  if (settings.discoveryEnabled) {
    if (!capabilities.braveConfigured) return { ready: false, blockedReason: 'brave_not_configured' };
    if (!capabilities.bravePersistenceAllowed) {
      return { ready: false, blockedReason: 'brave_persistence_disabled' };
    }
    if (!capabilities.openAiConfigured) return { ready: false, blockedReason: 'openai_not_configured' };
  }
  return { ready: true, blockedReason: null };
}

export function computeOperatorIdleStatus(input: {
  settings: BotSettings;
  now: number;
  latestStateChangeEvent: { action: string; actor: string; createdAt: string } | null;
  report: Phase3ValidationReport;
  capabilities: Phase3AutostartCapabilities;
  pilotStatus: Campaign['status'];
}): OperatorIdleStatus {
  const { settings, now, latestStateChangeEvent, report, capabilities, pilotStatus } = input;
  const phase3Status = report.run?.status ?? 'not_started';
  const awaitingReview = phase3Status === 'completed';

  if (settings.runState === 'running') {
    return {
      idle: false,
      runState: settings.runState,
      since: null,
      idleSeconds: null,
      cause: null,
      causedBy: null,
      phase3Status,
      awaitingReview: false,
      readyToResume: false,
      blockedReason: null,
      alert: false,
    };
  }

  const since = latestStateChangeEvent?.createdAt ?? null;
  const sinceMs = since ? Date.parse(since) : NaN;
  const idleSeconds = Number.isFinite(sinceMs) ? Math.max(0, Math.round((now - sinceMs) / 1000)) : null;

  // Answers "if the operator pressed Run right now, would real work actually
  // happen" -- mode-aware, since the criteria for that differ between
  // Shadow's one-time validation contract and normal live/dry_run operation.
  const { ready, blockedReason: computedBlockedReason } = computeReadyToResume({
    settings,
    report,
    capabilities,
    pilotStatus,
  });
  const readyToResume = !awaitingReview && ready;
  const blockedReason = !awaitingReview && !readyToResume ? computedBlockedReason : null;

  const alert =
    (readyToResume || awaitingReview) &&
    idleSeconds !== null &&
    idleSeconds * 1000 >= OPERATOR_IDLE_ALERT_THRESHOLD_MS;

  return {
    idle: true,
    runState: settings.runState,
    since,
    idleSeconds,
    cause: latestStateChangeEvent?.action ?? null,
    causedBy: latestStateChangeEvent?.actor ?? null,
    phase3Status,
    awaitingReview,
    readyToResume,
    blockedReason,
    alert,
  };
}

// Takes an already-fetched Phase 3 report so a caller that has one in hand
// (entry.ts's progress writer runs this every 5 minutes right alongside its
// own report fetch) doesn't pay for a second, identical Mongo round trip.
export async function getOperatorIdleStatusForReport(
  settings: BotSettings,
  report: Phase3ValidationReport,
): Promise<OperatorIdleStatus> {
  const [pilot, latestEvent] = await Promise.all([
    ensurePilotCampaign(),
    settings.runState === 'running' ? Promise.resolve(null) : findLatestAuditEvent(RUN_STATE_CHANGE_FILTER),
  ]);

  return computeOperatorIdleStatus({
    settings,
    now: Date.now(),
    latestStateChangeEvent: latestEvent
      ? { action: latestEvent.action, actor: latestEvent.actor, createdAt: latestEvent.createdAt }
      : null,
    report,
    capabilities: phase3AutostartCapabilities(),
    pilotStatus: pilot.status,
  });
}

export async function getOperatorIdleStatus(settings: BotSettings): Promise<OperatorIdleStatus> {
  const report = await getPhase3ValidationReport(settings);
  return getOperatorIdleStatusForReport(settings, report);
}
