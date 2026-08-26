import { describe, expect, it } from 'vitest';
import { candidateSchema } from '../src/domain/candidate.js';
import { complianceAssessmentSchema } from '../src/domain/compliance-assessment.js';
import { applyIdentityDedupGate } from '../src/services/dedup-compliance.service.js';

const assessment = complianceAssessmentSchema.parse({
  candidateId: 'candidate_1', policyVersion: 'test', status: 'pass', publicationEligible: true,
  seoIndexEligible: true, descriptionSimilarity: 0.1, reasons: [], fallbacks: [],
  mediaStrategy: 'eventflow_category_fallback', logoStrategy: 'initials_tile', assessedAt: new Date().toISOString(),
});

function candidate(dedupDecision?: 'strong_duplicate' | 'probable_duplicate' | 'distinct') {
  return candidateSchema.parse({
    id: 'candidate_1', campaignId: 'campaign_1', provider: 'manual', discoveryQuery: 'manual',
    sourceUrl: 'https://example.com', canonicalUrl: 'https://example.com/', canonicalDomain: 'example.com',
    titleHint: null, snippetHint: null, categoryHint: 'Venues', locationHint: 'Cardiff', status: 'shadow_ready',
    ...(dedupDecision ? { dedupDecision } : {}), discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

describe('identity dedup publication gate', () => {
  it('blocks a strong duplicate even when content compliance passed', () => {
    const gated = applyIdentityDedupGate(assessment, candidate('strong_duplicate'));
    expect(gated.status).toBe('block');
    expect(gated.publicationEligible).toBe(false);
    expect(gated.seoIndexEligible).toBe(false);
    expect(gated.reasons).toContain('strong_supplier_duplicate');
  });

  it('holds a probable duplicate for review', () => {
    const gated = applyIdentityDedupGate(assessment, candidate('probable_duplicate'));
    expect(gated.status).toBe('review');
    expect(gated.publicationEligible).toBe(false);
    expect(gated.reasons).toContain('probable_supplier_duplicate');
  });

  it('holds profiles until identity dedup has completed', () => {
    const gated = applyIdentityDedupGate(assessment, candidate());
    expect(gated.publicationEligible).toBe(false);
    expect(gated.reasons).toContain('identity_dedup_pending');
  });

  it('does not alter a distinct supplier assessment', () => {
    expect(applyIdentityDedupGate(assessment, candidate('distinct'))).toEqual(assessment);
  });
});
