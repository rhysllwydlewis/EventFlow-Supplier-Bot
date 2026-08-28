import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const hardResetSource = readFileSync('src/services/hard-reset.service.ts', 'utf8');
const runtimeControl = readFileSync('src/services/runtime-control.service.ts', 'utf8');
const server = readFileSync('src/control/server.ts', 'utf8');
const html = readFileSync('public/control.html', 'utf8');

describe('Hard reset', () => {
  it('wipes only acquired/generated data, never configuration, budgets, audit trail or suppression', () => {
    for (const collection of [
      'candidates',
      'shadow_profiles',
      'compliance_assessments',
      'dedup_assessments',
      'supplier_identities',
      'supplier_identity_keys',
      'evidence_fragments',
      'ai_extractions',
      'eventflow_ingestions',
      'validation_runs',
    ]) {
      expect(hardResetSource).toContain(`'${collection}'`);
    }
    // These must never be listed as reset targets: operator config, real
    // budget/cost ledgers and operational health state, the audit trail
    // (which should record the reset, not be erased by it), compliance
    // opt-out decisions, and the Hensol one-profile pilot's own state.
    for (const protectedCollection of [
      'bot_settings',
      'campaigns',
      'runtime_counters',
      'ai_usage',
      'provider_usage',
      'provider_circuits',
      'worker_heartbeats',
      'audit_events',
      'suppression',
      'eventflow_pilot_state',
    ]) {
      expect(hardResetSource).not.toContain(`'${protectedCollection}'`);
    }
    expect(hardResetSource).toContain('deleteMany({})');
  });

  it('pauses the pipeline, records the reset in the audit trail, and requires explicit server-side confirmation', () => {
    expect(runtimeControl).toContain('export async function hardResetBot(actor: string)');
    expect(runtimeControl).toContain('await pausePipelineQueues();');
    expect(runtimeControl).toContain("patchSettings({ runState: 'paused' }, actor)");
    expect(runtimeControl).toContain('await performHardReset();');
    expect(runtimeControl).toContain("recordAuditEvent(actor, 'bot.hard_reset', { deletedCounts })");

    // A destructive, irreversible action must not be triggerable by a bare
    // POST -- from a misclick, a replayed request, or a future UI bug --
    // without an explicit confirmation string in the request itself. This
    // gate is independent of (and in addition to) the dashboard's own
    // typed-confirmation prompt.
    expect(server).toContain("if (req.body?.confirm !== 'RESET')");
    expect(server).toContain("await hardResetBot(actor)");
  });

  it('requires the operator to type RESET before the dashboard sends the request', () => {
    expect(html).toContain('id="hardResetBtn"');
    expect(html).toContain("const typed=prompt(");
    expect(html).toContain("if(typed!=='RESET')return;");
    expect(html).toContain("request('/api/control/hard-reset',{method:'POST',body:JSON.stringify({confirm:'RESET'})})");
  });
});
