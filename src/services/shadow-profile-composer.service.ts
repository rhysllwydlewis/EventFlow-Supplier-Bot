import type { Candidate } from '../domain/candidate.js';
import type { SupplierMediaEvidence } from '../domain/supplier-media.js';
import { shadowProfileSchema, type ShadowProfile } from '../domain/shadow-profile.js';
import type { BasicExtraction } from '../extraction/basic-extractor.js';
import { extractStructuredBusinessFacts } from '../extraction/structured-data.js';
import { normalizePhone } from './supplier-dedup.service.js';

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

// UK business sites occasionally publish their JSON-LD telephone already
// mangled with a "+44" glued onto a number that still has its leading 0
// (e.g. "+4401443665803"). normalizePhone() strips that back to a valid
// local number; most EventFlow visitors are UK-based so a plain local
// number reads better than an international +44 form either way.
function cleanPublicPhone(raw: string | null): string | null {
  return normalizePhone(raw);
}

// Combine town/village with county when both are present (e.g. "Hensol,
// Vale of Glamorgan") instead of only ever keeping one via `||`, but don't
// repeat the same value twice if a site sets both fields identically.
function composeLocation(
  structured: { locality: string | null; region: string | null },
  fallback: string | null
): string | null {
  const combined = [structured.locality, structured.region]
    .filter((part, index, all): part is string => Boolean(part) && all.indexOf(part) === index)
    .join(', ');
  return combined || fallback || null;
}

export function composeDeterministicShadowProfile(input: {
  candidate: Candidate;
  extraction: BasicExtraction;
  evidenceIds: string[];
}): ShadowProfile {
  const structured = extractStructuredBusinessFacts(input.extraction.jsonLd);
  const businessName = structured.name || cleanBusinessTitle(input.candidate.titleHint) || input.candidate.canonicalDomain;
  const category = input.candidate.categoryHint || 'Other';
  const location = composeLocation(structured, input.candidate.locationHint);
  const email = structured.email || input.extraction.emails[0] || null;
  const phone = cleanPublicPhone(structured.telephone || input.extraction.phones[0] || null);
  const locationPhrase = location ? ` serving ${location}` : '';
  const priceInfo = input.extraction.advertisedPrices[0] || structured.priceRange || null;
  const pricePhrase = priceInfo ? ` Advertised pricing starts at ${priceInfo}.` : '';
  const description = `${businessName} is a ${category.toLowerCase()} supplier${locationPhrase}, listed on EventFlow from publicly available business information.${pricePhrase} This profile can be claimed by the business owner to add full details, packages and photos.`;
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
