import type { Candidate } from '../domain/candidate.js';
import type { SupplierMediaEvidence } from '../domain/supplier-media.js';
import { shadowProfileSchema, type ShadowProfile } from '../domain/shadow-profile.js';
import type { BasicExtraction } from '../extraction/basic-extractor.js';
import { extractStructuredBusinessFacts } from '../extraction/structured-data.js';

function cleanBusinessTitle(title: string | null): string | null {
  if (!title) return null;
  const value = title.split(/[|–—]/)[0]?.trim() || '';
  return value ? value.slice(0, 140) : null;
}

function representativePhoto(media: SupplierMediaEvidence[]): SupplierMediaEvidence | null {
  return media.find(item => {
    if (item.score < 85) return false;
    if (item.width === null || item.height === null) return true;
    const ratio = item.width / item.height;
    return ratio >= 0.55 && ratio <= 2.2;
  }) ?? null;
}

function mergeMediaEvidence(
  profileImageEvidence: SupplierMediaEvidence | null,
  media: SupplierMediaEvidence[],
): SupplierMediaEvidence[] {
  const result: SupplierMediaEvidence[] = [];
  const seen = new Set<string>();
  for (const item of [profileImageEvidence, ...media]) {
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    result.push(item);
    if (result.length >= 20) break;
  }
  return result;
}

export function composeDeterministicShadowProfile(input: {
  candidate: Candidate;
  extraction: BasicExtraction;
  evidenceIds: string[];
}): ShadowProfile {
  const structured = extractStructuredBusinessFacts(input.extraction.jsonLd);
  const businessName = structured.name || cleanBusinessTitle(input.candidate.titleHint) || input.candidate.canonicalDomain;
  const category = input.candidate.categoryHint || 'Other';
  const location = structured.locality || structured.region || input.candidate.locationHint;
  const email = structured.email || input.extraction.emails[0] || null;
  const phone = structured.telephone || input.extraction.phones[0] || null;
  const locationPhrase = location ? ` serving ${location}` : '';
  const description = `${businessName} is listed on EventFlow as a ${category.toLowerCase()} supplier${locationPhrase}. This profile has been compiled from publicly available business information and can be claimed by the business owner.`;
  const images = input.extraction.media.slice(0, 12).map(item => item.url);
  const coverImage = images[0] ?? null;
  const logoCandidate = input.extraction.profileImageCandidate ?? null;
  const photoFallback = representativePhoto(input.extraction.media);
  const profileImageEvidence = logoCandidate ?? photoFallback;
  const profileImage = profileImageEvidence?.url ?? null;
  const mediaEvidence = mergeMediaEvidence(logoCandidate, input.extraction.media);

  let confidence = 35;
  if (structured.name) confidence += 20;
  if (location) confidence += 10;
  if (email || phone) confidence += 10;
  if (input.extraction.advertisedPrices.length) confidence += 10;
  if (input.evidenceIds.length >= 2) confidence += 10;
  if (images.length > 0) confidence += 5;
  confidence = Math.min(confidence, 95);

  return shadowProfileSchema.parse({
    candidateId: input.candidate.id,
    businessName,
    category,
    location: location || null,
    website: input.candidate.canonicalUrl,
    description,
    publicEmail: email,
    publicPhone: phone,
    advertisedPrices: input.extraction.advertisedPrices,
    services: [],
    packages: [],
    evidenceIds: input.evidenceIds,
    profileImage,
    profileImageEvidence,
    coverImage,
    images,
    mediaEvidence,
    dataConfidence: confidence,
    publicationQuality: Math.min(confidence, 80),
    generatedAt: new Date().toISOString(),
    generatorVersion: 'deterministic-shadow-profile-image-v3',
  });
}
