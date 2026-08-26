import { describe, expect, it } from 'vitest';
import { shadowProfileSchema } from '../src/domain/shadow-profile.js';
import { assessSupplierDuplicate, normalizeBusinessName, normalizePhone, toSupplierIdentity } from '../src/services/supplier-dedup.service.js';

function profile(overrides: Record<string, unknown> = {}) {
  return shadowProfileSchema.parse({
    candidateId: 'candidate_new',
    businessName: 'Example Manor Ltd',
    category: 'Venues',
    location: 'Cardiff',
    website: 'https://example-manor.co.uk/',
    description: 'Example Manor is listed by EventFlow as a venue supplier serving Cardiff with factual public business information.',
    publicEmail: 'hello@example-manor.co.uk',
    publicPhone: '+44 29 2012 3456',
    advertisedPrices: [], services: ['Weddings'], packages: [], evidenceIds: ['e1','e2'],
    dataConfidence: 90, publicationQuality: 88, generatedAt: new Date().toISOString(), generatorVersion: 'test',
    ...overrides,
  });
}

describe('supplier identity deduplication', () => {
  it('normalizes common UK business identity forms', () => {
    expect(normalizeBusinessName('Example Manor LIMITED')).toBe('example manor');
    expect(normalizePhone('+44 (0)29 2012 3456')).toBe('02920123456');
  });

  it('marks matching name and public email as a strong duplicate across different domains', () => {
    const existing = toSupplierIdentity(profile({ candidateId: 'candidate_existing', website: 'https://old-domain.example/' }));
    const assessment = assessSupplierDuplicate(profile({ website: 'https://new-domain.example/' }), [existing]);
    expect(assessment.decision).toBe('strong_duplicate');
    expect(assessment.matchedCandidateId).toBe('candidate_existing');
    expect(assessment.signals).toContain('same_public_email');
    expect(assessment.signals).toContain('same_business_name');
  });

  it('quarantines a probable identity match rather than auto-discarding it', () => {
    const existing = toSupplierIdentity(profile({ candidateId: 'candidate_existing', publicEmail: null, publicPhone: null }));
    const assessment = assessSupplierDuplicate(profile({
      website: 'https://other-domain.example/', publicEmail: null, publicPhone: null, category: 'Photography',
    }), [existing]);
    expect(assessment.decision).toBe('probable_duplicate');
    expect(assessment.matchedCandidateId).toBe('candidate_existing');
  });

  it('keeps unrelated suppliers distinct', () => {
    const existing = toSupplierIdentity(profile({ candidateId: 'candidate_existing' }));
    const assessment = assessSupplierDuplicate(profile({
      businessName: 'Different Events', website: 'https://different.example/', location: 'Swansea',
      publicEmail: 'hello@different.example', publicPhone: '01792 555555',
    }), [existing]);
    expect(assessment.decision).toBe('distinct');
    expect(assessment.matchedCandidateId).toBeNull();
  });
});
