import { describe, expect, it } from 'vitest';
import type { EvidenceFragment } from '../src/evidence/evidence.js';
import type { ShadowProfile } from '../src/domain/shadow-profile.js';
import {
  applyDescriptionComplianceFallback,
  assessShadowProfileCompliance,
  descriptionEvidenceSimilarity,
} from '../src/services/compliance.service.js';

const evidence: EvidenceFragment[] = [{
  id: 'evidence_1',
  candidateId: 'candidate_1',
  sourceUrl: 'https://example.com/',
  sourceType: 'supplier_website',
  observedAt: '2026-08-26T00:00:00.000Z',
  contentHash: 'abc',
  excerpt: 'Our Cardiff wedding venue offers exclusive use of the ceremony room, reception hall and landscaped gardens for celebrations throughout the year.',
  metadata: {},
}];

const deterministic: ShadowProfile = {
  candidateId: 'candidate_1',
  businessName: 'Example Venue',
  category: 'Venues',
  location: 'Cardiff',
  website: 'https://example.com/',
  description: 'Example Venue is listed by EventFlow as a venues supplier serving Cardiff. This Shadow-mode summary is generated only from observed public business facts and has not been published to EventFlow.',
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
  it('detects near-verbatim source wording and falls back to EventFlow prose', () => {
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
});
