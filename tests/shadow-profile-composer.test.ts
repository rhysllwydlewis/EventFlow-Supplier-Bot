import { describe, expect, it } from 'vitest';
import { candidateSchema } from '../src/domain/candidate.js';
import { composeDeterministicShadowProfile } from '../src/services/shadow-profile-composer.service.js';

describe('deterministic shadow profile composer', () => {
  it('prefers structured identity and uses publication-safe unclaimed-profile wording', () => {
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
        emails: ['hello@example.com'], phones: [], advertisedPrices: ['from £5,995'], pageText: [], media: [],
        jsonLd: [{ '@type': 'EventVenue', name: 'Example Manor', address: { addressLocality: 'Cardiff' } }],
      },
    });
    expect(profile.businessName).toBe('Example Manor');
    expect(profile.location).toBe('Cardiff');
    expect(profile.description).toContain('can be claimed by the business owner');
    expect(profile.description).not.toContain('Shadow-mode');
    expect(profile.publicationQuality).toBeLessThanOrEqual(80);
    expect(profile.images).toEqual([]);
    expect(profile.coverImage).toBeNull();
  });

  it('selects ranked media references for cover and gallery while preserving provenance', () => {
    const now = new Date().toISOString();
    const candidate = candidateSchema.parse({
      id: 'candidate_media', campaignId: 'campaign_1', provider: 'mock', discoveryQuery: 'venues South Wales',
      sourceUrl: 'https://venue.example/weddings', canonicalUrl: 'https://venue.example/weddings', canonicalDomain: 'venue.example',
      titleHint: 'Venue Example | Weddings', snippetHint: null, categoryHint: 'Venues', locationHint: 'South Wales',
      status: 'ready_for_quality', discoveredAt: now, updatedAt: now,
    });
    const media = [
      {
        url: 'https://venue.example/images/hero.jpg', sourcePageUrl: 'https://venue.example/weddings',
        kind: 'inline_image' as const, alt: 'Wedding venue exterior', width: 1600, height: 900, score: 90, sameSite: true,
      },
      {
        url: 'https://venue.example/images/room.jpg', sourcePageUrl: 'https://venue.example/gallery',
        kind: 'inline_image' as const, alt: 'Reception room', width: 1200, height: 800, score: 80, sameSite: true,
      },
    ];
    const profile = composeDeterministicShadowProfile({
      candidate,
      evidenceIds: ['evidence_media'],
      extraction: { emails: [], phones: [], advertisedPrices: [], pageText: [], jsonLd: [], media },
    });

    expect(profile.coverImage).toBe(media[0]?.url);
    expect(profile.images).toEqual(media.map(item => item.url));
    expect(profile.mediaEvidence).toEqual(media);
  });
});