import { describe, expect, it } from 'vitest';
import { extractServiceTagsFromJsonLd, extractStructuredBusinessFacts } from '../src/extraction/structured-data.js';

describe('structured business extraction', () => {
  it('extracts LocalBusiness fields from JSON-LD', () => {
    const facts = extractStructuredBusinessFacts([{
      '@type': 'EventVenue',
      name: 'Example Manor',
      url: 'https://example.com',
      email: 'hello@example.com',
      telephone: '029 2012 3456',
      address: { addressLocality: 'Cardiff', addressRegion: 'South Wales', postalCode: 'CF1 1AA' },
      priceRange: '£££',
      sameAs: ['https://instagram.com/example'],
    }]);
    expect(facts.name).toBe('Example Manor');
    expect(facts.locality).toBe('Cardiff');
    expect(facts.priceRange).toBe('£££');
    expect(facts.sameAs).toEqual(['https://instagram.com/example']);
  });

  it('falls back to a nested contactPoint.email when there is no top-level email', () => {
    const facts = extractStructuredBusinessFacts([{
      '@type': 'LocalBusiness',
      name: 'Example Manor',
      contactPoint: { '@type': 'ContactPoint', email: 'events@example.com', contactType: 'sales' },
    }]);
    expect(facts.email).toBe('events@example.com');
  });

  it('prefers a top-level email over a nested contactPoint.email when both exist', () => {
    const facts = extractStructuredBusinessFacts([{
      '@type': 'LocalBusiness',
      name: 'Example Manor',
      email: 'hello@example.com',
      contactPoint: { '@type': 'ContactPoint', email: 'sales@example.com' },
    }]);
    expect(facts.email).toBe('hello@example.com');
  });

  it('reads contactPoint.email from an array of contact points', () => {
    const facts = extractStructuredBusinessFacts([{
      '@type': 'LocalBusiness',
      name: 'Example Manor',
      contactPoint: [
        { '@type': 'ContactPoint', contactType: 'support', telephone: '029 2012 3456' },
        { '@type': 'ContactPoint', contactType: 'sales', email: 'sales@example.com' },
      ],
    }]);
    expect(facts.email).toBe('sales@example.com');
  });
});

describe('extractServiceTagsFromJsonLd', () => {
  it('reads serviceType (string or array) from the matched business object', () => {
    expect(extractServiceTagsFromJsonLd([{ '@type': 'LocalBusiness', name: 'Example Manor', serviceType: 'Wedding venue' }]))
      .toEqual(['Wedding venue']);
    expect(extractServiceTagsFromJsonLd([{
      '@type': 'LocalBusiness',
      name: 'Example Manor',
      serviceType: ['Wedding venue', 'Corporate events'],
    }])).toEqual(['Wedding venue', 'Corporate events']);
  });

  it('reads makesOffer[].itemOffered.name, falling back to makesOffer[].name', () => {
    const tags = extractServiceTagsFromJsonLd([{
      '@type': 'LocalBusiness',
      name: 'Example Manor',
      makesOffer: [
        { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Christmas parties' } },
        { '@type': 'Offer', name: 'Bar hire' },
      ],
    }]);
    expect(tags).toEqual(['Christmas parties', 'Bar hire']);
  });

  it('returns nothing when there is no matched business object or no service signal', () => {
    expect(extractServiceTagsFromJsonLd([])).toEqual([]);
    expect(extractServiceTagsFromJsonLd([{ '@type': 'LocalBusiness', name: 'Example Manor' }])).toEqual([]);
  });

  it('handles makesOffer as a single object rather than an array', () => {
    const tags = extractServiceTagsFromJsonLd([{
      '@type': 'LocalBusiness',
      name: 'Example Manor',
      makesOffer: { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Christmas parties' } },
    }]);
    expect(tags).toEqual(['Christmas parties']);
  });

  it('finds the business object inside an @graph wrapper', () => {
    const tags = extractServiceTagsFromJsonLd([{
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Example Manor site' },
        { '@type': 'LocalBusiness', name: 'Example Manor', serviceType: 'Wedding venue' },
      ],
    }]);
    expect(tags).toEqual(['Wedding venue']);
  });
});
