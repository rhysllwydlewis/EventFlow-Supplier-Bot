import type { Campaign } from '../domain/campaign.js';
import type { BotSettings, RunState } from '../domain/settings.js';
import { type AuditEvent, listAuditEventsByAction } from '../repositories/audit.repository.js';
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

// How long the bot can sit idle-but-resumable before it's worth flagging
// rather than treating as a normal operator pause.
export const OPERATOR_IDLE_ALERT_THRESHOLD_MS = 6 * 60 * 60 * 1000;

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
  blockedReason: Phase3AutostartDecision['reason'] | null;
  alert: boolean;
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

  // Force the hypothetical to 'stopped' so this answers "if the operator
  // pressed Run right now, would real work actually happen" -- independent of
  // whether *autostart* (which only ever fires from a fresh 'stopped' state)
  // would also fire.
  const decision = phase3AutostartDecision({
    settings: { ...settings, runState: 'stopped' },
    report,
    capabilities,
    pilotStatus,
  });
  // Autostart declines to touch an already-started run ('existing_run') only
  // to avoid competing with it -- pressing Run manually resumes that same
  // run just fine, so it isn't actually a blocker for an operator.
  const readyToResume = !awaitingReview && (decision.eligible || decision.reason === 'existing_run');
  const blockedReason = !awaitingReview && !readyToResume ? decision.reason : null;

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

async function latestStateChangeAwayFromRunning(): Promise<AuditEvent | null> {
  const eventLists = await Promise.all(
    STATE_CHANGE_AWAY_FROM_RUNNING_ACTIONS.map(action => listAuditEventsByAction(action, 1)),
  );
  return (
    eventLists
      .map(events => events[0])
      .filter((event): event is AuditEvent => Boolean(event))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
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
    settings.runState === 'running' ? Promise.resolve(null) : latestStateChangeAwayFromRunning(),
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
