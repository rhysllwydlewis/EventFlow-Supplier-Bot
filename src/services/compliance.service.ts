import type { ComplianceAssessment } from '../domain/compliance-assessment.js';
import type { ShadowProfile } from '../domain/shadow-profile.js';
import type { EvidenceFragment } from '../evidence/evidence.js';

export const COMPLIANCE_POLICY_VERSION = 'shadow-compliance-v1';
const COPY_BLOCK_THRESHOLD = 0.65;
const SEO_COPY_THRESHOLD = 0.45;

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

  let maximum = 0;
  for (const fragment of evidence) {
    const sourceShingles = shingles(fragment.excerpt);
    if (sourceShingles.size === 0) continue;
    let matches = 0;
    for (const item of descriptionShingles) {
      if (sourceShingles.has(item)) matches += 1;
    }
    maximum = Math.max(maximum, matches / descriptionShingles.size);
  }
  return Math.min(1, maximum);
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
}): ComplianceAssessment {
  const profile = input.profile;
  const similarity = descriptionEvidenceSimilarity(profile.description, input.evidence);
  const reasons: string[] = [];
  const fallbacks: ComplianceAssessment['fallbacks'] = [];
  const suppliedEvidenceIds = new Set(input.evidence.map(item => item.id));
  const linkedEvidenceCount = new Set(
    profile.evidenceIds.filter(id => suppliedEvidenceIds.has(id)),
  ).size;

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
  if (similarity >= COPY_BLOCK_THRESHOLD) reasons.push('description_too_similar_to_source');
  if (!profile.location) reasons.push('missing_location');
  if (!profile.services.length) reasons.push('missing_service_depth');
  if (!profile.advertisedPrices.length && !profile.packages.length) reasons.push('pricing_not_publicly_available');

  const blockingReasons = new Set([
    'quality_below_publication_threshold',
    'missing_source_evidence',
    'unresolved_evidence_reference',
    'missing_core_identity',
    'description_too_similar_to_source',
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
