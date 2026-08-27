import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/domain/settings.js';
import { phase3AutostartDecision } from '../src/services/phase3-autostart.service.js';
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

function report(
  settings = defaultSettings(),
  run: Phase3ValidationRun | null = null,
) {
  return summarizePhase3Validation({
    settings,
    run,
    candidates: [],
    profiles: [],
    assessments: [],
  });
}

describe('Phase 3 autonomous runtime closeout', () => {
  it('autostarts only a fresh stopped safe pilot with the full provider pipeline ready', () => {
    const settings = defaultSettings();
    expect(
      phase3AutostartDecision({
        settings,
        report: report(settings),
        capabilities: readyCapabilities,
        pilotStatus: 'draft',
      }),
    ).toEqual({ eligible: true, reason: 'eligible' });
  });

  it('never overrides pause, drain or emergency-stop operator states', () => {
    for (const runState of ['paused', 'draining', 'emergency_stopped'] as const) {
      const settings = { ...defaultSettings(), runState };
      expect(
        phase3AutostartDecision({
          settings,
          report: report(settings),
          capabilities: readyCapabilities,
          pilotStatus: 'draft',
        }),
      ).toEqual({ eligible: false, reason: 'operator_state' });
    }
  });

  it('refuses to start when an outbound control is enabled', () => {
    const settings = { ...defaultSettings(), publishingEnabled: true };
    expect(
      phase3AutostartDecision({
        settings,
        report: report(settings),
        capabilities: readyCapabilities,
        pilotStatus: 'draft',
      }),
    ).toEqual({ eligible: false, reason: 'unsafe_controls' });
  });

  it('reports the exact missing provider capability without exposing secret values', () => {
    const settings = defaultSettings();
    expect(
      phase3AutostartDecision({
        settings,
        report: report(settings),
        capabilities: { ...readyCapabilities, braveConfigured: false },
        pilotStatus: 'draft',
      }),
    ).toEqual({ eligible: false, reason: 'brave_not_configured' });
    expect(
      phase3AutostartDecision({
        settings,
        report: report(settings),
        capabilities: { ...readyCapabilities, bravePersistenceAllowed: false },
        pilotStatus: 'draft',
      }),
    ).toEqual({ eligible: false, reason: 'brave_persistence_disabled' });
    expect(
      phase3AutostartDecision({
        settings,
        report: report(settings),
        capabilities: { ...readyCapabilities, openAiConfigured: false },
        pilotStatus: 'draft',
      }),
    ).toEqual({ eligible: false, reason: 'openai_not_configured' });
  });

  it('does not silently replace an existing or completed validation ledger', () => {
    const settings = defaultSettings();
    const collecting: Phase3ValidationRun = {
      id: 'phase3-shadow-validation',
      status: 'collecting',
      startedAt: '2026-08-27T00:00:00.000Z',
      completedAt: null,
      campaignId: 'campaign_south_wales_venues_pilot',
      targetCandidates: PHASE3_TARGET_CANDIDATES,
      updatedAt: '2026-08-27T00:00:00.000Z',
    };
    expect(
      phase3AutostartDecision({
        settings,
        report: report(settings, collecting),
        capabilities: readyCapabilities,
        pilotStatus: 'running',
      }),
    ).toEqual({ eligible: false, reason: 'existing_run' });

    const completed = {
      ...collecting,
      status: 'completed' as const,
      completedAt: '2026-09-10T00:00:00.000Z',
    };
    expect(
      phase3AutostartDecision({
        settings,
        report: report(settings, completed),
        capabilities: readyCapabilities,
        pilotStatus: 'running',
      }),
    ).toEqual({ eligible: false, reason: 'completed' });
  });

  it('uses the bootstrap entrypoint in production and writes only aggregate public progress', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    const entrySource = readFileSync(new URL('../src/control/entry.ts', import.meta.url), 'utf8');

    expect(packageJson.scripts['start:control']).toBe('node dist/control/entry.js');
    expect(entrySource).toContain('bootstrapPhase3Validation()');
    expect(entrySource).toContain("'phase3-progress.json'");
    expect(entrySource).not.toContain('CONTROL_ADMIN_KEY');
    expect(entrySource).not.toContain('CONTROL_SESSION_SECRET');
  });
});
