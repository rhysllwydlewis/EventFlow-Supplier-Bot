import { logger } from '../lib/logger.js';
import { listAuditEventsByAction } from '../repositories/audit.repository.js';
import { listCreatedOrExistingEventFlowIngestions } from '../repositories/eventflow-ingestion.repository.js';
import {
  getPublishedSupplierByDomain,
  recordPublishedSupplier,
} from '../repositories/published-supplier.repository.js';
import { getShadowProfile } from '../repositories/shadow-profile.repository.js';
import { canonicalDomain } from '../utils/url.js';

const PROFILE_PATH_SLUG = /^\/supplier\/([a-z0-9-]+)--[a-f0-9]{16}$/;

// recordPublishedSupplier (published-supplier.repository.ts) was only added
// to the ingestion success path once PR #33 shipped -- every EventFlow
// publication that happened before that deploy has no published_suppliers
// record at all, so it stays permanently stuck showing "Ready" in Shadow
// review and never appears under Published, no matter how much time passes.
// The audit trail (audit_events, action 'eventflow.ingestion_succeeded')
// predates that change and already has everything needed to backfill it,
// bar the slug -- which is recoverable from publicProfilePath's own format.
let backfillPromise: Promise<{ scanned: number; backfilled: number }> | null = null;

async function backfillFromAuditHistory(): Promise<{ scanned: number; backfilled: number }> {
  const events = await listAuditEventsByAction('eventflow.ingestion_succeeded', 500);
  let backfilled = 0;

  for (const event of events) {
    const candidateId = typeof event.details.candidateId === 'string' ? event.details.candidateId : null;
    const supplierId = typeof event.details.supplierId === 'string' ? event.details.supplierId : null;
    const publicProfilePath =
      typeof event.details.publicProfilePath === 'string' ? event.details.publicProfilePath : null;
    if (!candidateId || !supplierId || !publicProfilePath) {
      logger.debug({ candidateId, supplierId, publicProfilePath }, 'Skipping backfill candidate: missing required audit fields');
      continue;
    }

    const slugMatch = publicProfilePath.match(PROFILE_PATH_SLUG);
    const slug = slugMatch?.[1];
    if (!slug) {
      logger.debug({ candidateId, publicProfilePath }, 'Skipping backfill candidate: publicProfilePath did not match the expected slug format');
      continue;
    }

    const profile = await getShadowProfile(candidateId);
    if (!profile) {
      logger.debug({ candidateId }, 'Skipping backfill candidate: shadow profile no longer exists');
      continue;
    }

    const domain = canonicalDomain(profile.website);
    if (await getPublishedSupplierByDomain(domain)) {
      logger.debug({ candidateId, domain }, 'Skipping backfill candidate: already has a published_suppliers record');
      continue;
    }

    const publicationScope = event.details.publicationScope;
    await recordPublishedSupplier({
      canonicalDomain: domain,
      supplierId,
      slug,
      publicProfilePath,
      source: publicationScope === 'pilot_unclaimed' ? 'pilot' : 'campaign',
      businessName: profile.businessName,
    });
    backfilled += 1;
    logger.info({ candidateId, domain, businessName: profile.businessName }, 'Backfilled a published_suppliers record from ingestion audit history');
  }

  return { scanned: events.length, backfilled };
}

// A second, more direct reconciliation pass: eventflow_ingestions records
// its own 'created'/'existing' verdict unconditionally, on the same write
// that already succeeded against EventFlow -- unlike recordPublishedSupplier,
// which is wrapped in a best-effort try/catch specifically so a failure
// there can never fail the publish it's recording (see
// eventflow-ingestion.service.ts). That try/catch is exactly what can leave
// published_suppliers missing a row for a candidate that really is live,
// with nothing else ever correcting it afterwards -- the audit-history pass
// above only recovers from that if it can still resolve the domain via a
// surviving shadow profile keyed by the *original* candidateId, which a
// Hard Reset followed by rediscovery would have replaced with a new one.
// This pass is keyed directly by the *current* candidateId instead (the one
// still sitting in Shadow review), so it recovers the exact case a Hard
// Reset would defeat above: a genuinely-published domain whose shadow
// profile is still right there, just never linked back to
// published_suppliers.
async function backfillFromIngestionRecords(): Promise<{ scanned: number; backfilled: number }> {
  const ingestions = await listCreatedOrExistingEventFlowIngestions(500);
  let backfilled = 0;

  for (const ingestion of ingestions) {
    if (!ingestion.supplierId || !ingestion.slug) {
      logger.debug({ candidateId: ingestion.candidateId }, 'Skipping ingestion backfill: missing supplierId or slug');
      continue;
    }

    const profile = await getShadowProfile(ingestion.candidateId);
    if (!profile) {
      logger.debug({ candidateId: ingestion.candidateId }, 'Skipping ingestion backfill: shadow profile no longer exists');
      continue;
    }

    const domain = canonicalDomain(profile.website);
    if (await getPublishedSupplierByDomain(domain)) {
      logger.debug({ candidateId: ingestion.candidateId, domain }, 'Skipping ingestion backfill: already has a published_suppliers record');
      continue;
    }

    await recordPublishedSupplier({
      canonicalDomain: domain,
      supplierId: ingestion.supplierId,
      slug: ingestion.slug,
      publicProfilePath: ingestion.publicProfilePath ?? null,
      // eventflow_ingestions does not record publicationScope, and the
      // single-domain one-profile pilot is rare enough (one hardcoded
      // domain) that defaulting to 'campaign' here is the correct call for
      // every other candidate; this field is informational only.
      source: 'campaign',
      businessName: profile.businessName,
    });
    backfilled += 1;
    logger.info(
      { candidateId: ingestion.candidateId, domain, businessName: profile.businessName },
      'Backfilled a published_suppliers record directly from its eventflow_ingestions record',
    );
  }

  return { scanned: ingestions.length, backfilled };
}

async function runBackfill(): Promise<{ scanned: number; backfilled: number }> {
  const [fromAuditHistory, fromIngestionRecords] = await Promise.all([
    backfillFromAuditHistory(),
    backfillFromIngestionRecords(),
  ]);
  const scanned = fromAuditHistory.scanned + fromIngestionRecords.scanned;
  const backfilled = fromAuditHistory.backfilled + fromIngestionRecords.backfilled;
  logger.info({ scanned, backfilled }, 'published_suppliers backfill from ingestion audit history complete');
  return { scanned, backfilled };
}

export async function ensurePublishedSupplierBackfill(): Promise<{ scanned: number; backfilled: number }> {
  if (!backfillPromise) {
    backfillPromise = runBackfill().catch(error => {
      backfillPromise = null;
      throw error;
    });
  }
  return backfillPromise;
}
