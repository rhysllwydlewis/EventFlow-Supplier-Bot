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

  it('combines locality and county into one location instead of dropping the county', () => {
    const candidate = candidateSchema.parse({
      id: 'candidate_hensol', campaignId: 'campaign_1', provider: 'mock', discoveryQuery: 'wedding venues South Wales',
      sourceUrl: 'https://hensolcastle.example', canonicalUrl: 'https://hensolcastle.example/', canonicalDomain: 'hensolcastle.example',
      titleHint: 'Hensol Castle', snippetHint: null, categoryHint: 'Venues', locationHint: 'South Wales',
      status: 'ready_for_quality', discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const profile = composeDeterministicShadowProfile({
      candidate,
      evidenceIds: ['evidence_1'],
      extraction: {
        emails: [], phones: [], advertisedPrices: [], pageText: [], media: [],
        jsonLd: [
          {
            '@type': 'EventVenue',
            name: 'Hensol Castle',
            address: { addressLocality: 'Hensol', addressRegion: 'Vale of Glamorgan' },
          },
        ],
      },
    });
    expect(profile.location).toBe('Hensol, Vale of Glamorgan');
    expect(profile.description).toContain('serving Hensol, Vale of Glamorgan');
  });

  it('does not repeat the location when locality and region are identical', () => {
    const candidate = candidateSchema.parse({
      id: 'candidate_same_loc', campaignId: 'campaign_1', provider: 'mock', discoveryQuery: 'caterers Cardiff',
      sourceUrl: 'https://example-caterer.test', canonicalUrl: 'https://example-caterer.test/', canonicalDomain: 'example-caterer.test',
      titleHint: 'Example Caterer', snippetHint: null, categoryHint: 'Catering', locationHint: 'Cardiff',
      status: 'ready_for_quality', discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const profile = composeDeterministicShadowProfile({
      candidate,
      evidenceIds: ['evidence_1'],
      extraction: {
        emails: [], phones: [], advertisedPrices: [], pageText: [], media: [],
        jsonLd: [
          { '@type': 'Organization', name: 'Example Caterer', address: { addressLocality: 'Cardiff', addressRegion: 'Cardiff' } },
        ],
      },
    });
    expect(profile.location).toBe('Cardiff');
  });

  it('repairs a malformed "+44" scraped phone number into a valid UK local number', () => {
    const candidate = candidateSchema.parse({
      id: 'candidate_phone', campaignId: 'campaign_1', provider: 'mock', discoveryQuery: 'venues Vale of Glamorgan',
      sourceUrl: 'https://hensolcastle.example', canonicalUrl: 'https://hensolcastle.example/', canonicalDomain: 'hensolcastle.example',
      titleHint: 'Hensol Castle', snippetHint: null, categoryHint: 'Venues', locationHint: 'South Wales',
      status: 'ready_for_quality', discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const profile = composeDeterministicShadowProfile({
      candidate,
      evidenceIds: ['evidence_1'],
      extraction: {
        emails: [], phones: [], advertisedPrices: [], pageText: [], media: [],
        jsonLd: [{ '@type': 'EventVenue', name: 'Hensol Castle', telephone: '+4401443665803' }],
      },
    });
    expect(profile.publicPhone).toBe('01443665803');
  });

  it('weaves advertised pricing into the deterministic description instead of leaving it generic', () => {
    const candidate = candidateSchema.parse({
      id: 'candidate_priced', campaignId: 'campaign_1', provider: 'mock', discoveryQuery: 'venues South Wales',
      sourceUrl: 'https://priced-venue.example', canonicalUrl: 'https://priced-venue.example/', canonicalDomain: 'priced-venue.example',
      titleHint: 'Priced Venue', snippetHint: null, categoryHint: 'Venues', locationHint: 'South Wales',
      status: 'ready_for_quality', discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const profile = composeDeterministicShadowProfile({
      candidate,
      evidenceIds: ['evidence_1'],
      extraction: {
        emails: [], phones: [], advertisedPrices: ['From £2,500'], pageText: [], media: [],
        jsonLd: [{ '@type': 'EventVenue', name: 'Priced Venue' }],
      },
    });
    expect(profile.description).toContain('Advertised pricing starts at From £2,500.');
  });
});