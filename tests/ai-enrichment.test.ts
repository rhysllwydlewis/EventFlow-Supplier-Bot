import { describe, expect, it } from 'vitest';
import type { AiEnrichment } from '../src/domain/ai-enrichment.js';
import type { ShadowProfile } from '../src/domain/shadow-profile.js';
import type { EvidenceFragment } from '../src/evidence/evidence.js';
import {
  mergeAiEnrichment,
  validateEvidenceBackedEnrichment,
} from '../src/services/ai-enrichment.service.js';

const baseProfile: ShadowProfile = {
  candidateId: 'candidate_1',
  businessName: 'Example Venue',
  category: 'Venues',
  location: 'Cardiff',
  website: 'https://example.com/',
  description: 'Deterministic fallback description.',
  publicEmail: 'hello@example.com',
  publicPhone: null,
  advertisedPrices: ['£500'],
  services: [],
  packages: [],
  evidenceIds: ['evidence_1', 'evidence_2'],
  dataConfidence: 70,
  publicationQuality: 60,
  generatedAt: '2026-08-26T00:00:00.000Z',
  generatorVersion: 'deterministic-shadow-v1',
};

const enrichment: AiEnrichment = {
  businessName: { value: 'Example Venue Cardiff', evidenceIds: ['evidence_1'] },
  location: { value: 'Cardiff', evidenceIds: ['evidence_1'] },
  description: { value: 'Original EventFlow summary based on the supplied business evidence.', evidenceIds: ['evidence_1'] },
  services: [
    { value: 'Wedding receptions', evidenceIds: ['evidence_1'] },
    { value: 'Invented service', evidenceIds: ['evidence_unknown'] },
  ],
  advertisedPrices: [
    { value: 'From £750', evidenceIds: ['evidence_2'] },
  ],
  packages: [
    {
      kind: 'advertised_package',
      name: 'Classic Package',
      priceDisplay: 'From £1,000 per person',
      features: ['Venue hire', 'Tables'],
      evidenceIds: ['evidence_2'],
    },
  ],
};

function evidence(input: Partial<EvidenceFragment> & Pick<EvidenceFragment, 'id' | 'excerpt'>): EvidenceFragment {
  return {
    id: input.id,
    candidateId: 'candidate_1',
    sourceUrl: input.sourceUrl || 'https://example.com/packages',
    sourceType: 'supplier_website',
    observedAt: '2026-08-27T12:00:00.000Z',
    contentHash: `hash_${input.id}`,
    excerpt: input.excerpt,
    metadata: input.metadata || {},
  };
}

describe('AI evidence validation', () => {
  it('drops facts that cite evidence outside the supplied set', () => {
    const validated = validateEvidenceBackedEnrichment(enrichment, new Set(['evidence_1', 'evidence_2']));
    expect(validated.services.map(item => item.value)).toEqual(['Wedding receptions']);
    expect(validated.packages).toHaveLength(1);
    expect(validated.businessName.value).toBe('Example Venue Cardiff');
  });

  it('falls back to deterministic values when a scalar loses support', () => {
    const invalidDescription: AiEnrichment = {
      ...enrichment,
      description: { value: 'Unsupported claim', evidenceIds: ['unknown'] },
    };
    const validated = validateEvidenceBackedEnrichment(invalidDescription, new Set(['evidence_1', 'evidence_2']));
    const merged = mergeAiEnrichment(baseProfile, validated);
    expect(merged.description).toBe(baseProfile.description);
    expect(merged.services).toEqual(['Wedding receptions']);
    expect(merged.advertisedPrices).toContain('£500');
    expect(merged.advertisedPrices).toContain('From £750');
  });

  it('requires one commercial evidence block to support both package name and exact price wording', () => {
    const fragments = [
      evidence({
        id: 'evidence_1',
        excerpt: 'Classic Package includes venue hire and tables.',
        metadata: { commercialCandidate: true },
      }),
      evidence({
        id: 'evidence_2',
        excerpt: 'Another service is advertised From £1,000 per person.',
        metadata: { commercialCandidate: true },
      }),
    ];
    const crossMixed: AiEnrichment = {
      ...enrichment,
      packages: [{
        kind: 'advertised_package',
        name: 'Classic Package',
        priceDisplay: 'From £1,000 per person',
        features: ['Venue hire'],
        evidenceIds: ['evidence_1', 'evidence_2'],
      }],
    };
    const validated = validateEvidenceBackedEnrichment(
      crossMixed,
      new Set(['evidence_1', 'evidence_2']),
      fragments,
    );
    expect(validated.packages).toEqual([]);
  });

  it('preserves package provenance and structured price semantics after strict validation', () => {
    const fragments = [
      evidence({
        id: 'evidence_2',
        excerpt: 'Classic Package — From £1,000 per person + VAT. Includes venue hire and tables.',
        metadata: { commercialCandidate: true, commercialKindHint: 'advertised_package' },
      }),
    ];
    const supported: AiEnrichment = {
      ...enrichment,
      packages: [{
        kind: 'advertised_package',
        name: 'Classic Package',
        priceDisplay: 'From £1,000 per person + VAT',
        features: ['Venue hire', 'Tables', 'Invented champagne'],
        evidenceIds: ['evidence_2'],
      }],
    };
    const validated = validateEvidenceBackedEnrichment(
      supported,
      new Set(['evidence_1', 'evidence_2']),
      fragments,
    );
    expect(validated.packages[0]?.features).toEqual(['Venue hire', 'Tables']);

    const merged = mergeAiEnrichment(baseProfile, validated, fragments);
    expect(merged.packages[0]).toMatchObject({
      name: 'Classic Package',
      price: 'From £1,000 per person + VAT',
      priceDisplay: 'From £1,000 per person + VAT',
      sourceUrl: 'https://example.com/packages',
      sourceContentHash: 'hash_evidence_2',
      kind: 'advertised_package',
      priceDetails: {
        currency: 'GBP',
        amount: 1000,
        qualifier: 'from',
        unit: 'per_person',
        vatStatus: 'excluded',
      },
    });
  });
});
