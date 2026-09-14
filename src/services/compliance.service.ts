import type { ComplianceAssessment } from '../domain/compliance-assessment.js';
import type { ShadowProfile } from '../domain/shadow-profile.js';
import type { EvidenceFragment } from '../evidence/evidence.js';
import { isKnownNonSupplierDomain, isVenueCategoryContentMismatch } from './discovery-result-quality.service.js';

export const COMPLIANCE_POLICY_VERSION = 'shadow-compliance-v1';
const COPY_BLOCK_THRESHOLD = 0.65;
const SEO_COPY_THRESHOLD = 0.45;

// Well-known English/Scottish regions clearly outside any Wales-focused
// campaign's target area. Confirmed live in production: "Appleby Castle", a
// real venue in Cumbria (the Lake District), was published under a North
// Wales campaign because nothing checked the extracted location against
// what the campaign actually targets. Deliberately a denylist of markers
// foreign to Wales, not an allowlist requiring the word "Wales" itself --
// several genuinely correct North Wales profiles (e.g. a Rhyl or Llangollen
// postcode-only address) never say "Wales" at all, so requiring it would
// have blocked them too.
const NON_TARGET_REGION_MARKERS =
  /\b(cumbria|lake district|yorkshire|lancashire|cornwall|devon|somerset|dorset|hampshire|surrey|kent|essex|norfolk|suffolk|scotland|northern ireland|london|midlands)\b/i;

function hasNumericPriceContent(profile: ShadowProfile): boolean {
  const strings = [...profile.advertisedPrices, ...profile.packages.map(item => item.priceDisplay || item.price || '')];
  return strings.some(value => /\d/.test(value)) || profile.packages.some(item => item.priceDetails?.amount != null);
}

function isLocationOutsideTargetRegion(profileLocation: string | null, campaignLocations: string[]): boolean {
  if (!profileLocation || campaignLocations.length === 0) return false;
  const marker = NON_TARGET_REGION_MARKERS.exec(profileLocation)?.[0]?.toLowerCase();
  if (!marker) return false;
  return !campaignLocations.join(' ').toLowerCase().includes(marker);
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9£]+/g, ' ')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
}

function shingles(value: string, width = 5): Set<string> {
  const tokens = words(value);
  const result = new Set<string>();
  if (tokens.length < width) {
    if (tokens.length) result.add(tokens.join(' '));
    return result;
  }
  for (let index = 0; index <= tokens.length - width; index += 1) {
    result.add(tokens.slice(index, index + width).join(' '));
  }
  return result;
}

export function descriptionEvidenceSimilarity(description: string, evidence: EvidenceFragment[]): number {
  const descriptionShingles = shingles(description);
  if (descriptionShingles.size === 0) return 0;

  const matchedDescriptionShingles = new Set<string>();
  for (const fragment of evidence) {
    const sourceShingles = shingles(fragment.excerpt);
    if (sourceShingles.size === 0) continue;
    for (const item of descriptionShingles) {
      if (sourceShingles.has(item)) matchedDescriptionShingles.add(item);
    }
  }

  return Math.min(1, matchedDescriptionShingles.size / descriptionShingles.size);
}

export function effectiveMinimumPublicationQuality(
  globalMinimum: number,
  campaignMinimum?: number | null,
): number {
  const globalFloor = Math.max(0, Math.min(100, globalMinimum));
  const campaignFloor = Math.max(0, Math.min(100, campaignMinimum ?? 0));
  return Math.max(globalFloor, campaignFloor);
}

export function applyDescriptionComplianceFallback(input: {
  profile: ShadowProfile;
  deterministicProfile: ShadowProfile;
  evidence: EvidenceFragment[];
}): { profile: ShadowProfile; fallbackApplied: boolean; originalSimilarity: number } {
  const originalSimilarity = descriptionEvidenceSimilarity(input.profile.description, input.evidence);
  if (originalSimilarity < COPY_BLOCK_THRESHOLD) {
    return { profile: input.profile, fallbackApplied: false, originalSimilarity };
  }

  return {
    profile: {
      ...input.profile,
      description: input.deterministicProfile.description,
      generatorVersion: `${input.profile.generatorVersion}+description-fallback-v1`,
      generatedAt: new Date().toISOString(),
    },
    fallbackApplied: true,
    originalSimilarity,
  };
}

export function assessShadowProfileCompliance(input: {
  profile: ShadowProfile;
  evidence: EvidenceFragment[];
  minimumPublicationQuality: number;
  descriptionFallbackApplied?: boolean;
  campaignLocations?: string[] | undefined;
}): ComplianceAssessment {
  const profile = input.profile;
  const similarity = descriptionEvidenceSimilarity(profile.description, input.evidence);
  const reasons: string[] = [];
  const fallbacks: ComplianceAssessment['fallbacks'] = [];
  const suppliedEvidenceIds = new Set(input.evidence.map(item => item.id));
  const linkedEvidenceCount = new Set(
    profile.evidenceIds.filter(id => suppliedEvidenceIds.has(id)),
  ).size;
  const websiteDomain = (() => {
    try {
      return new URL(profile.website).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  })();

  if (input.descriptionFallbackApplied) {
    fallbacks.push({
      field: 'description',
      action: 'deterministic_eventflow_summary',
      reason: 'Semantic enrichment was too similar to source wording, so original EventFlow fallback prose was retained.',
    });
  }

  fallbacks.push({
    field: 'media',
    action: 'eventflow_category_fallback',
    reason: 'No supplier-specific media asset is approved for reuse in Shadow mode.',
  });
  fallbacks.push({
    field: 'logo',
    action: 'initials_tile',
    reason: 'No supplier logo reuse basis is recorded in Shadow mode.',
  });

  if (profile.publicationQuality < input.minimumPublicationQuality) reasons.push('quality_below_publication_threshold');
  if (linkedEvidenceCount === 0) reasons.push('missing_source_evidence');
  if (linkedEvidenceCount !== new Set(profile.evidenceIds).size) reasons.push('unresolved_evidence_reference');
  if (!profile.businessName || !profile.website || !profile.category) reasons.push('missing_core_identity');
  // Publication itself independently refuses a known non-supplier domain
  // (eventflow-publication.service.ts), but that check is invisible from the
  // Control dashboard's Shadow profile review table -- without it here too,
  // an operator sees "Ready" for a candidate that can never actually
  // publish. Surfacing it as a blocking compliance reason keeps that badge
  // honest regardless of how the candidate entered the pipeline.
  if (websiteDomain && isKnownNonSupplierDomain(websiteDomain)) reasons.push('non_supplier_domain');
  if (similarity >= COPY_BLOCK_THRESHOLD) reasons.push('description_too_similar_to_source');
  if (!profile.location) reasons.push('missing_location');
  if (!profile.services.length) reasons.push('missing_service_depth');
  if (!profile.advertisedPrices.length && !profile.packages.length) reasons.push('pricing_not_publicly_available');
  // Distinct from pricing_not_publicly_available above: this is not "no price
  // was found" (common and legitimate -- most suppliers price on enquiry),
  // it's "a price WAS extracted but it's not a usable one" -- confirmed live
  // in production as a bare "£" with no number at all.
  else if (!hasNumericPriceContent(profile)) reasons.push('pricing_format_invalid');
  // Confirmed live in production: zero real photos published (a directory
  // page's own URL had been recorded as the "website", so nothing on it was
  // actually a photo of the business).
  if (!profile.images.length) reasons.push('missing_media');
  if (isVenueCategoryContentMismatch(profile.category, `${profile.description} ${profile.services.join(' ')}`)) {
    reasons.push('category_mismatch_with_content');
  }
  if (isLocationOutsideTargetRegion(profile.location, input.campaignLocations ?? [])) {
    reasons.push('location_outside_target_region');
  }

  const blockingReasons = new Set([
    'quality_below_publication_threshold',
    'missing_source_evidence',
    'unresolved_evidence_reference',
    'missing_core_identity',
    'description_too_similar_to_source',
    'non_supplier_domain',
    'pricing_format_invalid',
    'missing_media',
    'category_mismatch_with_content',
    'location_outside_target_region',
    // A supplier profile with contact details but no location or services is
    // not a useful listing -- these already downgrade `status` to 'review',
    // but without being blocking too, the actual publish path (which checks
    // only `publicationEligible`, not `status`) can still auto-publish one.
    // pricing_not_publicly_available deliberately stays non-blocking: most
    // suppliers price on enquiry, and that's already reflected below in how
    // it alone doesn't downgrade status either.
    'missing_location',
    'missing_service_depth',
  ]);
  const publicationEligible = !reasons.some(reason => blockingReasons.has(reason));

  const seoIndexEligible = publicationEligible
    && profile.publicationQuality >= Math.max(80, input.minimumPublicationQuality)
    && profile.description.length >= 160
    && Boolean(profile.location)
    && profile.services.length > 0
    && linkedEvidenceCount >= 2
    && similarity < SEO_COPY_THRESHOLD;

  if (publicationEligible && !seoIndexEligible) reasons.push('seo_noindex_until_richer_profile');

  const status: ComplianceAssessment['status'] = !publicationEligible
    ? 'block'
    : reasons.some(reason => reason !== 'pricing_not_publicly_available')
      ? 'review'
      : 'pass';

  return {
    candidateId: profile.candidateId,
    policyVersion: COMPLIANCE_POLICY_VERSION,
    status,
    publicationEligible,
    seoIndexEligible,
    descriptionSimilarity: Number(similarity.toFixed(4)),
    reasons: [...new Set(reasons)],
    fallbacks,
    mediaStrategy: 'eventflow_category_fallback',
    logoStrategy: 'initials_tile',
    assessedAt: new Date().toISOString(),
  };
}
