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

  it('prefers a mailto: email over an unattributed one found elsewhere in page text', () => {
    // A staff bio's personal email address is a plain-text regex match with
    // no ownership signal; a mailto: link is the page author deliberately
    // marking an address as the contact to use.
    const extraction = extractBasicFacts({
      rootUrl: 'https://venue.example',
      finalRootUrl: 'https://venue.example/',
      failures: [],
      pages: [{
        url: 'https://venue.example/about',
        contentType: 'text/html',
        bytes: 400,
        html: `<html><body><p>Written by our events manager, jane.doe@personal-email.com.</p><a href="mailto:info@venue.example">Email us</a></body></html>`,
      }],
    });
    expect(extraction.emails[0]).toBe('info@venue.example');
    expect(extraction.emails).toContain('jane.doe@personal-email.com');
  });

  it("picks up a tel: phone number that never appears in the page's visible text", () => {
    const extraction = extractBasicFacts({
      rootUrl: 'https://venue.example',
      finalRootUrl: 'https://venue.example/',
      failures: [],
      pages: [{
        url: 'https://venue.example/contact',
        contentType: 'text/html',
        bytes: 200,
        html: `<html><body><a href="tel:+441443665803">Call us</a></body></html>`,
      }],
    });
    expect(extraction.phones).toContain('+441443665803');
  });

  it('prefers a tel: phone over an unattributed one found in page text', () => {
    const extraction = extractBasicFacts({
      rootUrl: 'https://venue.example',
      finalRootUrl: 'https://venue.example/',
      failures: [],
      pages: [{
        url: 'https://venue.example/blog/a-review',
        contentType: 'text/html',
        bytes: 400,
        html: `<html><body><p>A reviewer mentioned reaching a competitor on 029 1234 5678.</p><a href="tel:02920123456">Call the venue</a></body></html>`,
      }],
    });
    expect(extraction.phones[0]).toBe('02920123456');
  });
});
