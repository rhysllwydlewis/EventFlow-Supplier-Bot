import { env } from '../config/env.js';
import { crawlSupplierSite } from '../crawler/site-crawler.js';
import { shadowProfileSchema, type ShadowProfile } from '../domain/shadow-profile.js';
import { extractBasicFacts } from '../extraction/basic-extractor.js';
import { extractStructuredBusinessFacts } from '../extraction/structured-data.js';
import { closeMongo } from '../lib/mongo.js';
import { logger } from '../lib/logger.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import { getSettings } from '../repositories/settings.repository.js';
import { getShadowProfile, saveShadowProfile } from '../repositories/shadow-profile.repository.js';
import { getTodayCrawlCount, tryClaimDailyCrawlSlot } from '../services/crawl-budget.service.js';
import {
  fetchAuditQueue,
  refreshEventFlowSupplierData,
  type AuditQueueItem,
} from '../services/eventflow-quality-audit.service.js';
import { scoreShadowProfile } from '../services/quality.service.js';
import { cleanPublicPhone, composeDeterministicDescription } from '../services/shadow-profile-composer.service.js';

// Per-run cap from docs/unclaimed-quality-progress.md's Mandate: at most 10
// suppliers re-crawled and refreshed per run, regardless of how many the
// queue reports.
const MAX_SUPPLIERS_PER_RUN = 10;

interface SupplierAuditResult {
  supplierId: string;
  candidateId: string | null;
  website: string;
  gapsTargeted: string[];
  fixed: string[];
  skipped: Array<{ field: string; reason: string }>;
  outcome: 'refreshed' | 'no_real_fix_found' | 'skipped';
  reason?: string;
}

export function activeGapNames(gaps: AuditQueueItem['gaps']): string[] {
  const names: string[] = [];
  if (gaps.missingCoverImage) names.push('missingCoverImage');
  if (gaps.missingGalleryImages) names.push('missingGalleryImages');
  if (gaps.missingDescription) names.push('missingDescription');
  if (gaps.missingPhone) names.push('missingPhone');
  if (gaps.missingTags) names.push('missingTags');
  if (gaps.packagesMissingPhotos.length > 0) {
    names.push(`packagesMissingPhotos(${gaps.packagesMissingPhotos.length})`);
  }
  return names;
}

export async function auditOneSupplier(
  item: AuditQueueItem,
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<SupplierAuditResult> {
  const base: SupplierAuditResult = {
    supplierId: item.supplierId,
    candidateId: item.candidateId,
    website: item.website,
    gapsTargeted: activeGapNames(item.gaps),
    fixed: [],
    skipped: [],
    outcome: 'skipped',
  };

  if (!item.candidateId) {
    base.reason = 'audit_queue_item_missing_candidate_id';
    return base;
  }

  // The bot's own local copy of the last profile it successfully published
  // for this candidate is the only place this script can get the rest of a
  // valid refresh payload (businessName, category, existing description/
  // phone/tags/packages/media) without clobbering good data EventFlow's
  // public API never exposes back to us (e.g. dataConfidence, tags). No
  // local record means no safe way to build a full refresh payload here.
  const profile = await getShadowProfile(item.candidateId);
  if (!profile) {
    base.reason = 'no_local_shadow_profile_for_candidate';
    return base;
  }

  const claimed = await tryClaimDailyCrawlSlot(settings.maxCrawlsPerDay, env.ABSOLUTE_MAX_CRAWLS_PER_DAY);
  if (!claimed) {
    base.reason = 'daily_crawl_budget_exhausted';
    return base;
  }

  let crawl;
  try {
    crawl = await crawlSupplierSite(profile.website, 8);
  } catch (error) {
    base.reason = `recrawl_failed: ${error instanceof Error ? error.message : String(error)}`;
    return base;
  }

  const extraction = extractBasicFacts(crawl);
  const structured = extractStructuredBusinessFacts(extraction.jsonLd);
  const images = extraction.media.slice(0, 12).map(media => media.url);

  const patch: Partial<ShadowProfile> = {};
  const fixed: string[] = [];
  const skipped: Array<{ field: string; reason: string }> = [];

  if (item.gaps.missingCoverImage) {
    if (images.length > 0) {
      patch.coverImage = images[0] ?? null;
      fixed.push('coverImage');
    } else {
      skipped.push({ field: 'coverImage', reason: 'no_usable_image_found_on_recrawl' });
    }
  }
  if (item.gaps.missingGalleryImages) {
    if (images.length > 0) {
      patch.images = images;
      fixed.push('images');
    } else {
      skipped.push({ field: 'images', reason: 'no_usable_image_found_on_recrawl' });
    }
  }
  if (patch.coverImage !== undefined || patch.images !== undefined) {
    // Keep provenance in sync with whichever image field(s) just changed --
    // adding this run's evidence rather than replacing the existing array
    // outright, so an untouched image (e.g. gallery preserved while only
    // the cover image was fixed) never loses the evidence record that
    // backs it.
    const seenEvidenceUrls = new Set<string>();
    const mergedEvidence: ShadowProfile['mediaEvidence'] = [];
    for (const evidence of [...profile.mediaEvidence, ...extraction.media]) {
      if (seenEvidenceUrls.has(evidence.url)) continue;
      seenEvidenceUrls.add(evidence.url);
      mergedEvidence.push(evidence);
      if (mergedEvidence.length >= 20) break;
    }
    patch.mediaEvidence = mergedEvidence;
  }

  if (item.gaps.missingDescription) {
    const priceInfo = extraction.advertisedPrices[0] ?? null;
    const description = composeDeterministicDescription({
      businessName: profile.businessName,
      category: profile.category,
      location: profile.location,
      priceInfo,
    });
    if (description.length > profile.description.length) {
      patch.description = description;
      fixed.push('description');
    } else {
      skipped.push({ field: 'description', reason: 'recrawl_produced_no_richer_description' });
    }
  }

  if (item.gaps.missingPhone) {
    const phone = cleanPublicPhone(structured.telephone || extraction.phones[0] || null);
    // Same <=20 guard eventflow-ingestion.service.ts applies to this field:
    // a longer value (e.g. a number with a spelled-out extension) is real,
    // but EventFlow has nowhere to put it, so claiming this as a fix here
    // would be reported as "refreshed" locally while never actually
    // reaching EventFlow's phone field.
    if (phone && phone.length <= 20) {
      patch.publicPhone = phone;
      fixed.push('publicPhone');
    } else {
      skipped.push({
        field: 'publicPhone',
        reason: phone ? 'phone_number_too_long_for_eventflow_field' : 'no_phone_number_found_on_recrawl',
      });
    }
  }

  // Neither gap has a reliable deterministic fix path yet: BasicExtraction
  // carries no services/tags list at all (only emails/phones/prices/media/
  // jsonLd/pageText), and there is no way to reliably match one of this
  // page's generic extracted images to one specific package by name. Real
  // fixes for these need new extraction capability, not a guess -- see
  // docs/unclaimed-quality-progress.md's "Discovered along the way" entry
  // this run adds, rather than inventing a match here.
  if (item.gaps.missingTags) {
    skipped.push({ field: 'tags', reason: 'no_deterministic_service_tag_extraction_yet' });
  }
  if (item.gaps.packagesMissingPhotos.length > 0) {
    skipped.push({ field: 'packagesMissingPhotos', reason: 'no_reliable_photo_to_package_matching_yet' });
  }

  if (Object.keys(patch).length === 0) {
    base.outcome = 'no_real_fix_found';
    base.skipped = skipped;
    return base;
  }

  const merged = shadowProfileSchema.parse({
    ...profile,
    ...patch,
    generatedAt: new Date().toISOString(),
    generatorVersion: `${profile.generatorVersion}+unclaimed-quality-audit-v1`,
  });
  const quality = scoreShadowProfile(merged);
  const finalProfile: ShadowProfile = {
    ...merged,
    dataConfidence: quality.total,
    publicationQuality: quality.total,
  };

  const refreshResult = await refreshEventFlowSupplierData({ profile: finalProfile });
  if (refreshResult.status !== 'refreshed') {
    base.reason = `refresh_failed: ${refreshResult.reason}`;
    base.skipped = skipped;
    return base;
  }

  await saveShadowProfile(finalProfile);
  base.outcome = 'refreshed';
  base.fixed = fixed;
  base.skipped = skipped;
  return base;
}

// Mirrors eventflow-publication.service.ts's publicationControlBlockReason
// exactly -- this script performs the same class of action (a real write to
// live EventFlow supplier data), so it must be gated by the same operator
// controls, not the looser "not explicitly stopped" check a read-only or
// bot-internal-only job could get away with. In particular: settings.mode
// stays 'shadow' until an operator explicitly promotes to 'live', and
// runState only ever reaches 'running' via an explicit playBot() -- a
// paused/draining/stopped bot must never have this script push writes to
// production just because it isn't emergency_stopped.
export function auditControlBlockReason(settings: Awaited<ReturnType<typeof getSettings>>): string | null {
  if (settings.runState !== 'running') {
    return settings.runState === 'emergency_stopped' ? 'emergency_stopped' : `run_state_${settings.runState}`;
  }
  if (settings.mode !== 'live') return 'mode_not_live';
  if (!settings.refreshEnabled) return 'refresh_disabled';
  return null;
}

export async function main(): Promise<void> {
  const settings = await getSettings();
  const blockReason = auditControlBlockReason(settings);
  if (blockReason) {
    logger.warn({ reason: blockReason }, 'Unclaimed quality audit: skipping run');
    process.stdout.write(`${JSON.stringify({ skipped: true, reason: blockReason }, null, 2)}\n`);
    return;
  }

  // This counts against the same daily crawl ceiling discovery/publication
  // already share (docs/AUTONOMY.md) -- check remaining budget before
  // spending any of it here, and skip the whole cycle rather than push
  // through an already-tight ceiling.
  const crawlCeiling = Math.max(0, Math.min(settings.maxCrawlsPerDay, env.ABSOLUTE_MAX_CRAWLS_PER_DAY));
  const crawlsUsedSoFar = await getTodayCrawlCount();
  if (crawlCeiling === 0 || crawlsUsedSoFar >= crawlCeiling) {
    logger.warn({ crawlsUsedSoFar, crawlCeiling }, 'Unclaimed quality audit: daily crawl budget already exhausted, skipping cycle');
    process.stdout.write(
      `${JSON.stringify({ skipped: true, reason: 'crawl_budget_exhausted', crawlsUsedSoFar, crawlCeiling }, null, 2)}\n`,
    );
    return;
  }

  const queueResult = await fetchAuditQueue({ limit: MAX_SUPPLIERS_PER_RUN });
  if (queueResult.status !== 'fetched') {
    logger.warn({ queueResult }, 'Unclaimed quality audit: could not fetch audit queue, skipping cycle');
    process.stdout.write(`${JSON.stringify({ skipped: true, reason: queueResult.reason }, null, 2)}\n`);
    return;
  }

  const targets = queueResult.queue.slice(0, MAX_SUPPLIERS_PER_RUN);
  const audited: SupplierAuditResult[] = [];
  for (const item of targets) {
    const result = await auditOneSupplier(item, settings);
    audited.push(result);
    await recordAuditEvent('unclaimed-quality-audit', 'quality_audit.supplier_audited', {
      supplierId: result.supplierId,
      candidateId: result.candidateId,
      outcome: result.outcome,
      fixed: result.fixed,
      skippedFields: result.skipped.map(item => item.field),
      reason: result.reason ?? null,
    }).catch(() => undefined);
    // The shared crawl ceiling can be exhausted by other traffic mid-run --
    // stop spending queue items once it is, rather than let every
    // remaining item fail one at a time for the same reason.
    if (result.reason === 'daily_crawl_budget_exhausted') {
      break;
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        totalPublished: queueResult.totalPublished,
        totalNeedingWork: queueResult.totalNeedingWork,
        audited,
      },
      null,
      2,
    )}\n`,
  );
}

// Guards the auto-run so importing this module (e.g. from a test) never
// executes main() against a real database/network -- unlike
// phase3-validation-report.ts (which has no such guard and always runs
// main() on import), this module exports auditOneSupplier/main themselves
// for direct test coverage, so it needs one. This project compiles to
// CommonJS (tsconfig's "module": "NodeNext" with no "type": "module" in
// package.json), so require.main is the correct entry-point check here,
// not import.meta.
if (require.main === module) {
  main()
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeMongo().catch(() => undefined);
    });
}
