import { describe, expect, it } from 'vitest';
import { extractStructuredBusinessFacts } from '../src/extraction/structured-data.js';

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
});
