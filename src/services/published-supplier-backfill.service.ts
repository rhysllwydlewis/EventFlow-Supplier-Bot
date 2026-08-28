import { logger } from '../lib/logger.js';
import { listAuditEventsByAction } from '../repositories/audit.repository.js';
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

async function runBackfill(): Promise<{ scanned: number; backfilled: number }> {
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

  logger.info({ scanned: events.length, backfilled }, 'published_suppliers backfill from ingestion audit history complete');
  return { scanned: events.length, backfilled };
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
