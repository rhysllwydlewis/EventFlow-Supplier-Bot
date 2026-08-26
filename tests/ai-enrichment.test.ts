import { describe, expect, it } from 'vitest';
import type { AiEnrichment } from '../src/domain/ai-enrichment.js';
import type { ShadowProfile } from '../src/domain/shadow-profile.js';
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
    { name: 'Classic', price: '£1,000', features: ['Venue hire', 'Tables'], evidenceIds: ['evidence_2'] },
  ],
};

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
});
