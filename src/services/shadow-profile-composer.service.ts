import type { Candidate } from '../domain/candidate.js';
import { shadowProfileSchema, type ShadowProfile } from '../domain/shadow-profile.js';
import type { BasicExtraction } from '../extraction/basic-extractor.js';
import { extractStructuredBusinessFacts } from '../extraction/structured-data.js';

function cleanBusinessTitle(title: string | null): string | null {
  if (!title) return null;
  const value = title.split(/[|–—]/)[0]?.trim() || '';
  return value ? value.slice(0, 140) : null;
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

  let confidence = 35;
  if (structured.name) confidence += 20;
  if (location) confidence += 10;
  if (email || phone) confidence += 10;
  if (input.extraction.advertisedPrices.length) confidence += 10;
  if (input.evidenceIds.length >= 2) confidence += 10;
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
    dataConfidence: confidence,
    publicationQuality: Math.min(confidence, 80),
    generatedAt: new Date().toISOString(),
    generatorVersion: 'deterministic-shadow-v1',
  });
}
