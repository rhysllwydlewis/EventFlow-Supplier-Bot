import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/domain/settings.js';
import {
  computeOperatorIdleStatus,
  OPERATOR_IDLE_ALERT_THRESHOLD_MS,
} from '../src/services/operator-idle.service.js';
import {
  PHASE3_TARGET_CANDIDATES,
  summarizePhase3Validation,
  type Phase3ValidationRun,
} from '../src/services/phase3-validation.service.js';

const readyCapabilities = {
  braveConfigured: true,
  bravePersistenceAllowed: true,
  openAiConfigured: true,
};

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const SEVEN_HOURS_AGO = new Date(NOW - 7 * 60 * 60 * 1000).toISOString();
const ONE_HOUR_AGO = new Date(NOW - 60 * 60 * 1000).toISOString();

function report(settings = defaultSettings(), run: Phase3ValidationRun | null = null) {
  return summarizePhase3Validation({ settings, run, candidates: [], profiles: [], assessments: [] });
}

describe('operator idle detection', () => {
  it('is never idle while the bot is running', () => {
    const settings = { ...defaultSettings(), runState: 'running' as const };
    const status = computeOperatorIdleStatus({
      settings,
      now: NOW,
      latestStateChangeEvent: { action: 'bot.pause', actor: 'control-admin', createdAt: SEVEN_HOURS_AGO },
      report: report(settings),
      capabilities: readyCapabilities,
      pilotStatus: 'running',
    });
    expect(status).toMatchObject({ idle: false, alert: false, since: null, idleSeconds: null });
  });

  it('does not alert when no audit trail explains the idle state (idleSeconds unknown)', () => {
    const settings = { ...defaultSettings(), runState: 'paused' as const };
    const status = computeOperatorIdleStatus({
      settings,
      now: NOW,
      latestStateChangeEvent: null,
      report: report(settings),
      capabilities: readyCapabilities,
      pilotStatus: 'draft',
    });
    expect(status).toMatchObject({ idle: true, since: null, idleSeconds: null, alert: false });
  });

  it('alerts once a resumable idle state has outlasted the threshold', () => {
    const settings = { ...defaultSettings(), runState: 'paused' as const };
    const status = computeOperatorIdleStatus({
      settings,
      now: NOW,
      latestStateChangeEvent: { action: 'bot.hard_reset', actor: 'control-admin', createdAt: SEVEN_HOURS_AGO },
      report: report(settings),
      capabilities: readyCapabilities,
      pilotStatus: 'draft',
    });
    expect(status.idleSeconds).toBeGreaterThan(OPERATOR_IDLE_ALERT_THRESHOLD_MS / 1000);
    expect(status).toMatchObject({
      idle: true,
      cause: 'bot.hard_reset',
      causedBy: 'control-admin',
      readyToResume: true,
      blockedReason: null,
      awaitingReview: false,
      alert: true,
    });
  });

  it('does not alert on a fresh, short-lived pause', () => {
    const settings = { ...defaultSettings(), runState: 'paused' as const };
    const status = computeOperatorIdleStatus({
      settings,
      now: NOW,
      latestStateChangeEvent: { action: 'bot.pause', actor: 'control-admin', createdAt: ONE_HOUR_AGO },
      report: report(settings),
      capabilities: readyCapabilities,
      pilotStatus: 'draft',
    });
    expect(status).toMatchObject({ idle: true, readyToResume: true, alert: false });
  });

  it('reports why it cannot resume instead of alerting when a real capability is missing', () => {
    const settings = { ...defaultSettings(), runState: 'emergency_stopped' as const };
    const status = computeOperatorIdleStatus({
      settings,
      now: NOW,
      latestStateChangeEvent: {
        action: 'phase3.validation_invalidated',
        actor: 'phase3-validator',
        createdAt: SEVEN_HOURS_AGO,
      },
      report: report(settings),
      capabilities: { ...readyCapabilities, openAiConfigured: false },
      pilotStatus: 'draft',
    });
    expect(status).toMatchObject({
      idle: true,
      readyToResume: false,
      blockedReason: 'openai_not_configured',
      alert: false,
    });
  });

  it('treats an existing in-progress run as resumable, not blocked', () => {
    const settings = { ...defaultSettings(), runState: 'draining' as const };
    const collecting: Phase3ValidationRun = {
      id: 'phase3-shadow-validation',
      status: 'draining',
      startedAt: '2026-08-27T00:00:00.000Z',
      completedAt: null,
      campaignId: 'campaign_south_wales_venues_pilot',
      targetCandidates: PHASE3_TARGET_CANDIDATES,
      updatedAt: '2026-08-27T00:00:00.000Z',
    };
    const status = computeOperatorIdleStatus({
      settings,
      now: NOW,
      latestStateChangeEvent: {
        action: 'phase3.validation_target_reached',
        actor: 'phase3-validator',
        createdAt: SEVEN_HOURS_AGO,
      },
      report: report(settings, collecting),
      capabilities: readyCapabilities,
      pilotStatus: 'running',
    });
    expect(status).toMatchObject({ readyToResume: true, blockedReason: null, alert: true });
  });

  it('flags a completed validation run as awaiting review rather than resumable', () => {
    const settings = { ...defaultSettings(), runState: 'stopped' as const };
    const completed: Phase3ValidationRun = {
      id: 'phase3-shadow-validation',
      status: 'completed',
      startedAt: '2026-08-27T00:00:00.000Z',
      completedAt: '2026-09-05T00:00:00.000Z',
      campaignId: 'campaign_south_wales_venues_pilot',
      targetCandidates: PHASE3_TARGET_CANDIDATES,
      updatedAt: '2026-09-05T00:00:00.000Z',
    };
    const status = computeOperatorIdleStatus({
      settings,
      now: NOW,
      latestStateChangeEvent: { action: 'bot.drain_completed', actor: 'system-reconciler', createdAt: SEVEN_HOURS_AGO },
      report: report(settings, completed),
      capabilities: readyCapabilities,
      pilotStatus: 'running',
    });
    expect(status).toMatchObject({
      awaitingReview: true,
      readyToResume: false,
      blockedReason: null,
      alert: true,
    });
  });

  it('is ready to resume when idle in live mode with providers configured (regression: was always false)', () => {
    // Production bug found in review: readyToResume reused
    // phase3AutostartDecision unconditionally, which requires mode==='shadow'
    // to ever report eligible. The moment an operator moves to 'live' -- the
    // normal, intended day-to-day mode -- readyToResume was structurally
    // stuck at false forever with blockedReason 'unsafe_controls', even
    // though nothing was actually wrong. Confirmed against the live
    // production dashboard before this fix.
    const settings = { ...defaultSettings(), mode: 'live' as const, runState: 'paused' as const };
    const status = computeOperatorIdleStatus({
      settings,
      now: NOW,
      latestStateChangeEvent: { action: 'bot.pause', actor: 'control-admin', createdAt: SEVEN_HOURS_AGO },
      report: report(settings),
      capabilities: readyCapabilities,
      pilotStatus: 'running',
    });
    expect(status).toMatchObject({ readyToResume: true, blockedReason: null, alert: true });
  });

  it('reports the real blocking reason in live mode when a provider is actually missing', () => {
    const settings = { ...defaultSettings(), mode: 'live' as const, runState: 'paused' as const };
    const status = computeOperatorIdleStatus({
      settings,
      now: NOW,
      latestStateChangeEvent: { action: 'bot.pause', actor: 'control-admin', createdAt: SEVEN_HOURS_AGO },
      report: report(settings),
      capabilities: { ...readyCapabilities, braveConfigured: false },
      pilotStatus: 'running',
    });
    expect(status).toMatchObject({ readyToResume: false, blockedReason: 'brave_not_configured', alert: false });
  });

  it('is not ready to resume when mode is off, regardless of capabilities', () => {
    const settings = { ...defaultSettings(), mode: 'off' as const, runState: 'paused' as const };
    const status = computeOperatorIdleStatus({
      settings,
      now: NOW,
      latestStateChangeEvent: { action: 'bot.pause', actor: 'control-admin', createdAt: SEVEN_HOURS_AGO },
      report: report(settings),
      capabilities: readyCapabilities,
      pilotStatus: 'running',
    });
    expect(status).toMatchObject({ readyToResume: false, blockedReason: 'mode_off' });
  });

  it('live mode with discovery off is ready to resume even without provider keys', () => {
    // Without discovery there is nothing for Brave/OpenAI to feed -- refresh
    // and publication retries can still be worth resuming for.
    const settings = { ...defaultSettings(), mode: 'live' as const, runState: 'paused' as const, discoveryEnabled: false };
    const status = computeOperatorIdleStatus({
      settings,
      now: NOW,
      latestStateChangeEvent: { action: 'bot.pause', actor: 'control-admin', createdAt: SEVEN_HOURS_AGO },
      report: report(settings),
      capabilities: { braveConfigured: false, bravePersistenceAllowed: false, openAiConfigured: false },
      pilotStatus: 'running',
    });
    expect(status).toMatchObject({ readyToResume: true, blockedReason: null });
  });

  it('also watches for runState changed via a direct settings update, not just the control actions', () => {
    // settingsPatchSchema (control/server.ts) is derived from the full
    // settings schema and does not omit runState, so PUT /api/settings can
    // move the bot out of 'running' too -- recording a plain 'settings.update'
    // audit event instead of bot.pause/drain/emergency_stop/hard_reset. A
    // source-string check (rather than exercising the real Mongo query) is
    // this repo's usual way of covering something that needs a live database
    // to actually run -- findLatestAuditEvent's filter is what's asserted on.
    const source = readFileSync(new URL('../src/services/operator-idle.service.ts', import.meta.url), 'utf8');
    expect(source).toContain("action: 'settings.update'");
    expect(source).toContain("'details.effectivePatch.runState': { $exists: true }");
  });
});
