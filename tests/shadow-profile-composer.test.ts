import { describe, expect, it } from 'vitest';
import { candidateSchema } from '../src/domain/candidate.js';
import { composeDeterministicShadowProfile } from '../src/services/shadow-profile-composer.service.js';

describe('deterministic shadow profile composer', () => {
  it('prefers structured identity and never claims EventFlow publication', () => {
    const candidate = candidateSchema.parse({
      id: 'candidate_1', campaignId: 'campaign_1', provider: 'mock', discoveryQuery: 'wedding venues Cardiff',
      sourceUrl: 'https://example.com', canonicalUrl: 'https://example.com/', canonicalDomain: 'example.com',
      titleHint: 'Example Manor | Weddings', snippetHint: null, categoryHint: 'Venues', locationHint: 'South Wales',
      status: 'ready_for_quality', discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const profile = composeDeterministicShadowProfile({
      candidate,
      evidenceIds: ['evidence_1', 'evidence_2'],
      extraction: {
        emails: ['hello@example.com'], phones: [], advertisedPrices: ['from £5,995'], pageText: [],
        jsonLd: [{ '@type': 'EventVenue', name: 'Example Manor', address: { addressLocality: 'Cardiff' } }],
      },
    });
    expect(profile.businessName).toBe('Example Manor');
    expect(profile.location).toBe('Cardiff');
    expect(profile.description).toContain('Shadow-mode');
    expect(profile.publicationQuality).toBeLessThanOrEqual(80);
  });
});
