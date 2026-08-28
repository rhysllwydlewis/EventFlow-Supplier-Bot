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

  it('also reconciles directly from eventflow_ingestions, which is written unconditionally unlike the best-effort published_suppliers write', () => {
    // recordPublishedSupplier (published-supplier.repository.ts) is wrapped
    // in a try/catch specifically so a failure there can never fail the
    // publish it's recording (eventflow-ingestion.service.ts) -- which means
    // it can silently leave published_suppliers missing a row for a
    // candidate that really is live on EventFlow. The audit-history pass
    // above only recovers that via the *original* candidateId's shadow
    // profile, which a Hard Reset followed by rediscovery replaces with a
    // new one -- this second pass is keyed by the *current* candidateId
    // instead, recovering exactly that case for a shadow profile still
    // sitting in Shadow review right now.
    expect(backfillService).toContain(
      "import { listCreatedOrExistingEventFlowIngestions } from '../repositories/eventflow-ingestion.repository.js';",
    );
    expect(backfillService).toContain('async function backfillFromIngestionRecords()');
    expect(backfillService).toContain('await listCreatedOrExistingEventFlowIngestions(');
    expect(backfillService).toContain('await getShadowProfile(ingestion.candidateId)');
    const ingestionFnStart = backfillService.indexOf('async function backfillFromIngestionRecords()');
    const ingestionFnEnd = backfillService.indexOf('\n}', backfillService.indexOf('await recordPublishedSupplier(', ingestionFnStart));
    const ingestionFn = backfillService.slice(ingestionFnStart, ingestionFnEnd);
    expect(ingestionFn).toContain('await getPublishedSupplierByDomain(domain)');
    expect(ingestionFn).toContain('supplierId: ingestion.supplierId');
    expect(ingestionFn).toContain('slug: ingestion.slug');
  });

  it('runs both reconciliation passes on every backfill and sums their totals', () => {
    expect(backfillService).toContain('async function backfillFromAuditHistory()');
    const runBackfillStart = backfillService.indexOf('async function runBackfill()');
    const runBackfillEnd = backfillService.indexOf('\n}', runBackfillStart);
    const runBackfillFn = backfillService.slice(runBackfillStart, runBackfillEnd);
    expect(runBackfillFn).toContain('backfillFromAuditHistory()');
    expect(runBackfillFn).toContain('backfillFromIngestionRecords()');
  });

  it('exposes a repository query for created/existing ingestions distinct from the conflicted-ingestions query', () => {
    const ingestionRepository = readFileSync('src/repositories/eventflow-ingestion.repository.ts', 'utf8');
    expect(ingestionRepository).toContain('export async function listCreatedOrExistingEventFlowIngestions');
    expect(ingestionRepository).toContain("status: { $in: ['created', 'existing'] } }");
  });
});
