import { describe, expect, it } from 'vitest';
import type { EvidenceFragment } from '../src/evidence/evidence.js';
import type { ShadowProfile } from '../src/domain/shadow-profile.js';
import {
  applyDescriptionComplianceFallback,
  assessShadowProfileCompliance,
  descriptionEvidenceSimilarity,
} from '../src/services/compliance.service.js';

const evidence: EvidenceFragment[] = [
  {
    id: 'evidence_1',
    candidateId: 'candidate_1',
    sourceUrl: 'https://example.com/',
    sourceType: 'supplier_website',
    observedAt: '2026-08-26T00:00:00.000Z',
    contentHash: 'abc',
    excerpt: 'Our Cardiff wedding venue offers exclusive use of the ceremony room, reception hall and landscaped gardens for celebrations throughout the year.',
    metadata: {},
  },
  {
    id: 'evidence_2',
    candidateId: 'candidate_1',
    sourceUrl: 'https://example.com/contact',
    sourceType: 'supplier_website',
    observedAt: '2026-08-26T00:00:00.000Z',
    contentHash: 'def',
    excerpt: 'Example Venue is based in Cardiff and can be contacted for wedding venue hire enquiries.',
    metadata: {},
  },
];

const deterministic: ShadowProfile = {
  candidateId: 'candidate_1',
  businessName: 'Example Venue',
  category: 'Venues',
  location: 'Cardiff',
  website: 'https://example.com/',
  description: 'Example Venue is listed on EventFlow as a venues supplier serving Cardiff. This profile has been compiled from publicly available business information and can be claimed by the business owner.',
  publicEmail: 'hello@example.com',
  publicPhone: '029 2000 0000',
  advertisedPrices: ['From £900'],
  services: ['Wedding venue hire'],
  packages: [],
  evidenceIds: ['evidence_1', 'evidence_2'],
  dataConfidence: 90,
  publicationQuality: 90,
  generatedAt: '2026-08-26T00:00:00.000Z',
  generatorVersion: 'deterministic-shadow-v1',
};

describe('Shadow compliance gate', () => {
  it('detects near-verbatim source wording and falls back to publication-safe EventFlow prose', () => {
    const copied: ShadowProfile = {
      ...deterministic,
      description: evidence[0]!.excerpt,
      generatorVersion: 'deterministic+openai-structured-v1',
    };
    expect(descriptionEvidenceSimilarity(copied.description, evidence)).toBeGreaterThanOrEqual(0.65);
    const result = applyDescriptionComplianceFallback({
      profile: copied,
      deterministicProfile: deterministic,
      evidence,
    });
    expect(result.fallbackApplied).toBe(true);
    expect(result.profile.description).toBe(deterministic.description);
    expect(result.profile.description).not.toContain('Shadow-mode');
  });

  it('separates publication eligibility from stricter SEO index eligibility', () => {
    const assessment = assessShadowProfileCompliance({
      profile: deterministic,
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.publicationEligible).toBe(true);
    expect(assessment.seoIndexEligible).toBe(true);
    expect(assessment.mediaStrategy).toBe('eventflow_category_fallback');
    expect(assessment.logoStrategy).toBe('initials_tile');
  });

  it('does not invent or require pricing for an otherwise factual listing', () => {
    const profile = { ...deterministic, advertisedPrices: [], packages: [] };
    const assessment = assessShadowProfileCompliance({
      profile,
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(profile.packages).toEqual([]);
    expect(assessment.publicationEligible).toBe(true);
    expect(assessment.reasons).toContain('pricing_not_publicly_available');
  });

  it('blocks publication below the configured quality floor', () => {
    const assessment = assessShadowProfileCompliance({
      profile: { ...deterministic, publicationQuality: 60 },
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.publicationEligible).toBe(false);
    expect(assessment.status).toBe('block');
    expect(assessment.reasons).toContain('quality_below_publication_threshold');
  });

  it('blocks profiles that claim provenance which was not supplied to the assessment', () => {
    const assessment = assessShadowProfileCompliance({
      profile: { ...deterministic, evidenceIds: ['evidence_1', 'evidence_missing'] },
      evidence,
      minimumPublicationQuality: 75,
    });
    expect(assessment.publicationEligible).toBe(false);
    expect(assessment.seoIndexEligible).toBe(false);
    expect(assessment.reasons).toContain('unresolved_evidence_reference');
  });
});
