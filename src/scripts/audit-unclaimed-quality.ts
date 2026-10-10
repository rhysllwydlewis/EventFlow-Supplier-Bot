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
import { matchPackagePhotos } from '../services/package-photo-matcher.js';
import { recordProviderUsage, tryClaimProviderSearch } from '../services/provider-usage.service.js';
import {
  crawlNamesBusiness,
  hostLooksLikeBusiness,
  isDirectorySourceUrl,
  pagesAboutBusiness,
  pickSourceCandidate,
  significantNameTokens,
  sourceSearchQuery,
  type SourceKind,
} from '../services/source-resolver.service.js';
import { getDiscoveryProvider } from '../providers/discovery/index.js';
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
  // Set when the recorded website was a third-party directory page and a
  // better single-business source was resolved and verified instead.
  resolvedSource?: { url: string; kind: SourceKind };
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

async function resolveBetterSource(
  profile: ShadowProfile,
): Promise<{ url: string; kind: SourceKind } | { reason: string }> {
  const searchClaimed = await tryClaimProviderSearch('brave', env.ABSOLUTE_MAX_PROVIDER_SEARCHES_PER_DAY);
  if (!searchClaimed) return { reason: 'daily_provider_search_budget_exhausted' };
  let results;
  try {
    results = await getDiscoveryProvider('brave').search({
      query: sourceSearchQuery(profile.businessName, profile.location),
      country: 'gb',
      count: 10,
    });
  } catch (error) {
    return { reason: `source_search_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  await recordProviderUsage({ provider: 'brave', resultsSeen: results.length }).catch(() => undefined);
  // Only the chosen URL is used and logged -- the search result titles and
  // snippets are never stored (BRAVE_PERSISTENCE_ALLOWED may be off).
  const picked = pickSourceCandidate(profile.businessName, profile.category, profile.website, results);
  return picked ?? { reason: 'recorded_website_is_a_directory_listing_and_no_better_source_found' };
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

  const claimCrawlSlot = async (): Promise<boolean> => {
    const claimed = await tryClaimDailyCrawlSlot(settings.maxCrawlsPerDay, env.ABSOLUTE_MAX_CRAWLS_PER_DAY);
    if (!claimed) base.reason = 'daily_crawl_budget_exhausted';
    return claimed;
  };

  // A recorded website on a third-party directory is usually a listing page
  // describing many businesses: its phone/photos are not this supplier's.
  // Find (and independently verify) a single-business page for this
  // supplier first; if none, skip rather than mine the listing page.
  let crawlTarget = profile.website;
  let sourceKind: SourceKind = 'own_site';
  if (isDirectorySourceUrl(profile.website)) {
    const resolved = await resolveBetterSource(profile);
    if ('reason' in resolved) {
      base.reason = resolved.reason;
      return base;
    }
    crawlTarget = resolved.url;
    sourceKind = resolved.kind;
    base.resolvedSource = resolved;
  }

  // Claimed only now that there is something to crawl, so a skipped
  // directory profile (no source found / search budget gone) burns no
  // crawl-ceiling slot.
  if (!(await claimCrawlSlot())) return base;

  let crawl;
  try {
    crawl = await crawlSupplierSite(crawlTarget, 8);
  } catch (error) {
    base.reason = `recrawl_failed: ${error instanceof Error ? error.message : String(error)}`;
    return base;
  }

  let extraction = extractBasicFacts(crawl);
  if (base.resolvedSource) {
    // The resolved page may be reached through a redirect to somewhere else
    // entirely: re-derive the source kind from where the crawl actually
    // ended up, never from the search result's URL alone.
    const finalHost = new URL(crawl.finalRootUrl).hostname.toLowerCase();
    if (isDirectorySourceUrl(crawl.finalRootUrl) || !hostLooksLikeBusiness(finalHost, profile.businessName)) {
      sourceKind = 'directory_profile';
      base.resolvedSource = { url: base.resolvedSource.url, kind: 'directory_profile' };
    }
    if (!profile.location) {
      base.reason = 'resolved_source_cannot_be_verified_without_a_profile_location';
      return base;
    }
    // Only pages that individually name the business and its town may
    // contribute any fact: a phone/photo/tag pooled from the rest of a
    // directory (other suppliers, footer, "similar" blocks) is not theirs.
    const aboutPages = pagesAboutBusiness(profile.businessName, profile.location, extraction.pageText, page => page.text);
    if (aboutPages.length === 0) {
      base.reason = 'resolved_source_has_no_page_naming_the_business_and_its_location';
      return base;
    }
    const keep = new Set(aboutPages.map(page => page.url));
    extraction = extractBasicFacts({ ...crawl, pages: crawl.pages.filter(page => keep.has(page.url)) });
  }
  let structured = extractStructuredBusinessFacts(extraction.jsonLd);
  let serviceTags = extraction.serviceTags;
  // A resolved source's JSON-LD only counts when the typed object's own name
  // is this business (a parent company/agency Organization must not leak
  // its phone or services onto the listing).
  if (base.resolvedSource) {
    const nameTokens = significantNameTokens(profile.businessName);
    const structuredNamesBusiness = Boolean(structured.name) && crawlNamesBusiness(profile.businessName, [{ url: '', text: structured.name! }]) && nameTokens.length > 0;
    if (!structuredNamesBusiness) {
      structured = { ...structured, telephone: null };
      serviceTags = [];
    }
  }
  // Photos on a third-party directory page are uploaded to that directory;
  // only reuse images from the supplier's own site.
  const usableMedia = sourceKind === 'own_site' ? extraction.media : [];
  const images = usableMedia.slice(0, 12).map(media => media.url);

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
    // Pooled tel: links from a third-party page are not trusted (footer/
    // support numbers); only the business's own site may supply one.
    const pooledPhone = sourceKind === 'own_site' ? extraction.phones[0] : null;
    const phone = cleanPublicPhone(structured.telephone || pooledPhone || null);
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

  if (item.gaps.missingTags) {
    if (serviceTags.length > 0) {
      patch.services = serviceTags;
      fixed.push('services');
    } else {
      skipped.push({ field: 'tags', reason: 'no_deterministic_service_tags_found_on_recrawl' });
    }
  }

  if (item.gaps.packagesMissingPhotos.length > 0) {
    const matches = matchPackagePhotos(item.gaps.packagesMissingPhotos, profile.packages, usableMedia);
    if (matches.length > 0) {
      // Keyed by array position, not package name -- two packages can
      // legitimately share a name, and each match was independently
      // verified against its own package's sourceUrl, so applying by name
      // could otherwise cross-attach one package's photo to its
      // same-named sibling.
      const imageByIndex = new Map(matches.map(match => [match.packageIndex, match.imageUrl]));
      patch.packages = profile.packages.map((pkg, index) => {
        const matchedImage = imageByIndex.get(index);
        return matchedImage ? { ...pkg, image: matchedImage } : pkg;
      });
      fixed.push('packages');
    }
    const unmatchedCount = item.gaps.packagesMissingPhotos.length - matches.length;
    if (unmatchedCount > 0) {
      skipped.push({ field: 'packagesMissingPhotos', reason: 'no_reliable_photo_to_package_matching_yet' });
    }
  }

  if (patch.coverImage !== undefined || patch.images !== undefined || patch.packages !== undefined) {
    // Keep provenance in sync with whichever image-bearing field(s) just
    // changed -- adding this run's evidence rather than replacing the
    // existing array outright, so an untouched image (e.g. gallery
    // preserved while only the cover image or a package photo was fixed)
    // never loses the evidence record that backs it.
    const seenEvidenceUrls = new Set<string>();
    const mergedEvidence: ShadowProfile['mediaEvidence'] = [];
    for (const evidence of [...profile.mediaEvidence, ...usableMedia]) {
      if (seenEvidenceUrls.has(evidence.url)) continue;
      seenEvidenceUrls.add(evidence.url);
      mergedEvidence.push(evidence);
      if (mergedEvidence.length >= 20) break;
    }
    patch.mediaEvidence = mergedEvidence;
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

// One compact, single-line-loggable summary of a run. The full pretty-printed
// JSON written to stdout gets interleaved line by line in hosted log viewers
// (Railway), so this is also emitted as a single structured log entry.
export function summarizeRun(
  totals: { totalPublished: number; totalNeedingWork: number },
  audited: SupplierAuditResult[],
): Record<string, unknown> {
  const outcomes: Record<string, number> = {};
  for (const result of audited) {
    outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
  }
  return {
    totalPublished: totals.totalPublished,
    totalNeedingWork: totals.totalNeedingWork,
    audited: audited.length,
    fixedSuppliers: audited.filter(result => result.fixed.length > 0).length,
    outcomes,
    suppliers: audited.map(result => ({
      supplierId: result.supplierId,
      website: result.website,
      outcome: result.outcome,
      fixed: result.fixed,
      reasons: [...new Set([...(result.reason ? [result.reason] : []), ...result.skipped.map(item => item.reason)])],
    })),
  };
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

  logger.info(
    summarizeRun(queueResult, audited),
    'Unclaimed quality audit: run summary',
  );

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
