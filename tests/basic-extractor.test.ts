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

  it('does not pick up an email address that only appears inside a <script> block', () => {
    // Phones and prices are matched against the tag-stripped page text
    // (below); emails must be too, or an analytics/tracking-widget config
    // literal (a demo address, a vendor's own support inbox) ends up
    // treated as this business's public contact -- the same "no ownership
    // signal" problem the mailto:-preference comment above already flags,
    // just via script content instead of a stray free-text mention.
    const extraction = extractBasicFacts({
      rootUrl: 'https://venue.example',
      finalRootUrl: 'https://venue.example/',
      failures: [],
      pages: [{
        url: 'https://venue.example/',
        contentType: 'text/html',
        bytes: 400,
        html: `<html><head><script>window.chatWidgetConfig = { fallbackInbox: "support@chat-widget-vendor.example" };</script></head><body><p>Call us to book your day, we'd love to help.</p></body></html>`,
      }],
    });
    expect(extraction.emails).not.toContain('support@chat-widget-vendor.example');
  });

  it('still finds an email in an unquoted mailto: href', () => {
    // MAILTO_HREF_RE only recognises a quoted href, so this relies on the
    // plain-text email scan as a fallback -- scoping that scan to
    // script/style-stripped (not fully tag-stripped) content must not
    // remove the surrounding <a> tag, or this address is lost entirely.
    const extraction = extractBasicFacts({
      rootUrl: 'https://venue.example',
      finalRootUrl: 'https://venue.example/',
      failures: [],
      pages: [{
        url: 'https://venue.example/',
        contentType: 'text/html',
        bytes: 200,
        html: `<html><body><a href=mailto:hello@venue.example>Email us</a></body></html>`,
      }],
    });
    expect(extraction.emails).toContain('hello@venue.example');
  });

  it('still finds an email published only through schema.org microdata', () => {
    // <meta itemprop="email" content="..."> carries the address purely in
    // an attribute value -- full tag-stripping (stripTags) would delete it
    // along with the tag, so the email scan must not use that.
    const extraction = extractBasicFacts({
      rootUrl: 'https://venue.example',
      finalRootUrl: 'https://venue.example/',
      failures: [],
      pages: [{
        url: 'https://venue.example/',
        contentType: 'text/html',
        bytes: 200,
        html: `<html><body><meta itemprop="email" content="hello@venue.example"><p>Get in touch.</p></body></html>`,
      }],
    });
    expect(extraction.emails).toContain('hello@venue.example');
  });

  it('still finds an email on an accepted text/plain crawl response', () => {
    // A non-HTML body run through stripTags's tag-stripping regex would
    // have "<hello@venue.example>" misparsed as an HTML tag and deleted --
    // the email scan must not depend on that stripping.
    const extraction = extractBasicFacts({
      rootUrl: 'https://venue.example',
      finalRootUrl: 'https://venue.example/',
      failures: [],
      pages: [{
        url: 'https://venue.example/contact.txt',
        contentType: 'text/plain',
        bytes: 100,
        html: `Contact: <hello@venue.example>`,
      }],
    });
    expect(extraction.emails).toContain('hello@venue.example');
  });

  it('still finds an email beyond the 100,000-character page-text truncation limit', () => {
    // `text` (used for phones/prices/pageText) is capped at 100k chars, but
    // the email scan reads the untruncated body -- a long page's footer
    // email must not be lost just because it comes after that cap.
    const padding = 'x'.repeat(150_000);
    const extraction = extractBasicFacts({
      rootUrl: 'https://venue.example',
      finalRootUrl: 'https://venue.example/',
      failures: [],
      pages: [{
        url: 'https://venue.example/',
        contentType: 'text/html',
        bytes: padding.length,
        html: `<html><body><p>${padding}</p><footer>hello@venue.example</footer></body></html>`,
      }],
    });
    expect(extraction.emails).toContain('hello@venue.example');
  });

  it('reads service tags from JSON-LD serviceType/makesOffer and dedupes across pages', () => {
    const extraction = extractBasicFacts({
      rootUrl: 'https://venue.example',
      finalRootUrl: 'https://venue.example/',
      failures: [],
      pages: [
        {
          url: 'https://venue.example/',
          contentType: 'text/html',
          bytes: 400,
          html: `<html><body><script type="application/ld+json">{"@type":"LocalBusiness","name":"Example Manor","serviceType":["Wedding venue","Corporate events"]}</script></body></html>`,
        },
        {
          url: 'https://venue.example/weddings',
          contentType: 'text/html',
          bytes: 400,
          html: `<html><body><script type="application/ld+json">{"@type":"LocalBusiness","name":"Example Manor","serviceType":"Wedding venue"}</script></body></html>`,
        },
      ],
    });
    expect(extraction.serviceTags).toEqual(['Wedding venue', 'Corporate events']);
  });

  it('ignores <meta name="keywords">: unvetted free text pooled from anywhere on the site is not this field\'s deterministic source', () => {
    const extraction = extractBasicFacts({
      rootUrl: 'https://venue.example',
      finalRootUrl: 'https://venue.example/',
      failures: [],
      pages: [{
        url: 'https://venue.example/',
        contentType: 'text/html',
        bytes: 200,
        html: `<html><head><meta name="keywords" content="Marquee hire, Outdoor ceremonies"></head><body></body></html>`,
      }],
    });
    expect(extraction.serviceTags).toEqual([]);
  });

  it('drops a service tag candidate longer than the 120-char field limit rather than truncating it into a mangled fragment', () => {
    const overlong = `Full wedding planning package including catering, floristry, venue styling, and day-of coordination for up to 200 wedding guests`;
    expect(overlong.length).toBeGreaterThan(120);
    const extraction = extractBasicFacts({
      rootUrl: 'https://venue.example',
      finalRootUrl: 'https://venue.example/',
      failures: [],
      pages: [{
        url: 'https://venue.example/',
        contentType: 'text/html',
        bytes: 400,
        html: `<html><body><script type="application/ld+json">{"@type":"LocalBusiness","name":"Example Manor","makesOffer":[{"itemOffered":{"name":"${overlong}"}},{"name":"Bar hire"}]}</script></body></html>`,
      }],
    });
    expect(extraction.serviceTags).toEqual(['Bar hire']);
  });

  it('returns no service tags when JSON-LD offers no service signal', () => {
    const extraction = extractBasicFacts({
      rootUrl: 'https://venue.example',
      finalRootUrl: 'https://venue.example/',
      failures: [],
      pages: [{
        url: 'https://venue.example/',
        contentType: 'text/html',
        bytes: 100,
        html: `<html><body><p>No structured data here.</p></body></html>`,
      }],
    });
    expect(extraction.serviceTags).toEqual([]);
  });
});
