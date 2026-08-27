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

// UK business sites occasionally publish their JSON-LD telephone already
// mangled with a "+44"/"0044" glued directly onto a UK local number that
// still has its leading 0 (e.g. "+4401443665803" -> "01443665803"). Repair
// only that specific pattern rather than reusing supplier-dedup's
// normalizePhone(), which strips every non-digit character and would fold
// a genuine extension (e.g. "029 2012 3456 ext. 123") straight into the
// subscriber number, publishing an uncallable value.
function cleanPublicPhone(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const repaired = trimmed.replace(/^(?:\+44|0044)[\s.-]*0(\d{9,10})\b/, '0$1');
  return repaired.slice(0, 60);
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
  // advertisedPrices are regex-matched £ amounts from page text, but the
  // "from"/"starting at" qualifier is optional in that match, so a bare
  // amount (a deposit, a single add-on) is not necessarily a minimum price.
  // Report it neutrally rather than claiming it's a starting price.
  // structured.priceRange is excluded here: schema.org allows a categorical
  // tier symbol like "£££" there, which isn't a stateable amount at all.
  const priceInfo = input.extraction.advertisedPrices[0] || null;
  const pricePhrase = priceInfo ? ` Advertised pricing: ${priceInfo}.` : '';
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
