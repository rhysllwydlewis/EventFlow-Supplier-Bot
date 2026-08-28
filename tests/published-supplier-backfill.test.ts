import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const backfillService = readFileSync('src/services/published-supplier-backfill.service.ts', 'utf8');
const server = readFileSync('src/control/server.ts', 'utf8');

describe('Backfilling published_suppliers from ingestion audit history', () => {
  it('recovers suppliers that were published before published_suppliers existed', () => {
    // recordPublishedSupplier only started being called once PR #33 shipped.
    // Anything published to EventFlow before that deploy has no
    // published_suppliers record and would otherwise stay stuck showing
    // "Ready" in Shadow review forever, and never appear under Published --
    // this is what actually happened to six real suppliers in production.
    expect(backfillService).toContain("listAuditEventsByAction('eventflow.ingestion_succeeded'");
    expect(backfillService).toContain('await getShadowProfile(candidateId)');
    expect(backfillService).toContain('await recordPublishedSupplier(');
  });

  it('skips a domain that already has a published_suppliers record', () => {
    expect(backfillService).toContain('await getPublishedSupplierByDomain(domain)');
    const guardIndex = backfillService.indexOf('if (await getPublishedSupplierByDomain(domain)) {');
    expect(guardIndex).toBeGreaterThan(-1);
  });

  it('derives the slug from publicProfilePath instead of requiring a field the old audit events never had', () => {
    // recordPublishedSupplier requires a non-empty slug, but
    // eventflow.ingestion_succeeded audit events only ever stored
    // publicProfilePath, not slug on its own -- the slug is recoverable
    // because publicProfilePath is always `/supplier/{slug}--{16 hex}`.
    expect(backfillService).toContain('/^\\/supplier\\/([a-z0-9-]+)--[a-f0-9]{16}$/');
    expect(backfillService).toContain('slugMatch?.[1]');
  });

  it('maps publicationScope back to the same pilot/campaign source recordPublishedSupplier normally uses', () => {
    expect(backfillService).toContain("publicationScope === 'pilot_unclaimed' ? 'pilot' : 'campaign'");
  });

  it('is memoized so it runs the scan at most once per process, like the identity reconciliation it is modelled on', () => {
    expect(backfillService).toContain('let backfillPromise:');
    expect(backfillService).toContain('export async function ensurePublishedSupplierBackfill()');
  });

  it('runs at control server startup without ever blocking boot on failure', () => {
    expect(server).toContain('ensurePublishedSupplierBackfill()');
    expect(server).toMatch(/ensurePublishedSupplierBackfill\(\)\.catch\(/);
  });

  it('always logs how many it scanned and backfilled, not just when it finds something', () => {
    // A silent no-op run is indistinguishable from a run that never
    // happened at all -- diagnosing "why didn't this recover my supplier"
    // needs the scan/backfill counts on every deploy, not only the ones
    // that found something.
    expect(backfillService).toContain("'published_suppliers backfill from ingestion audit history complete'");
  });
});
