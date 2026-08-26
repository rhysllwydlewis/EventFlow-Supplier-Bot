import { describe, expect, it } from 'vitest';
import { extractBasicFacts } from '../src/extraction/basic-extractor.js';

describe('basic website extraction', () => {
  it('extracts public contact details, prices and JSON-LD without AI', () => {
    const extraction = extractBasicFacts({
      rootUrl: 'https://venue.example',
      finalRootUrl: 'https://venue.example/',
      failures: [],
      pages: [{
        url: 'https://venue.example/weddings',
        contentType: 'text/html',
        bytes: 400,
        html: `<html><body><script type="application/ld+json">{"@type":"LocalBusiness","name":"Example Manor"}</script><p>Wedding packages from £5,995. Call 029 2012 3456 or hello@venue.example.</p></body></html>`,
      }],
    });
    expect(extraction.emails).toContain('hello@venue.example');
    expect(extraction.advertisedPrices).toContain('from £5,995');
    expect(extraction.jsonLd).toHaveLength(1);
    expect(extraction.pageText[0]?.text).toContain('Wedding packages');
  });
});
