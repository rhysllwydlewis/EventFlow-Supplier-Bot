import { describe, expect, it } from 'vitest';
import { shadowProfileSchema } from '../src/domain/shadow-profile.js';
import { scoreShadowProfile } from '../src/services/quality.service.js';

describe('shadow quality scoring', () => {
  it('keeps quality components explainable', () => {
    const profile = shadowProfileSchema.parse({
      candidateId: 'candidate_1', businessName: 'Example Manor', category: 'Venues', location: 'Cardiff', website: 'https://example.com/',
      description: 'Example Manor is a wedding venue serving Cardiff with publicly observed business information for Shadow-mode evaluation only.',
      publicEmail: 'hello@example.com', publicPhone: '029 2012 3456', advertisedPrices: ['from £5,995'], services: [], packages: [],
      evidenceIds: ['e1','e2','e3'], dataConfidence: 90, publicationQuality: 0, generatedAt: new Date().toISOString(), generatorVersion: 'test',
    });
    const score = scoreShadowProfile(profile);
    expect(score.identity).toBe(40);
    expect(score.evidence).toBe(15);
    expect(score.total).toBeGreaterThan(60);
    expect(score.reasons).toContain('thin_content');
  });
});
