import { describe, expect, it } from 'vitest';
import { extractLinks } from '../src/crawler/html-links.js';

describe('HTML link extraction', () => {
  it('resolves useful HTTP links and ignores contact/script schemes', () => {
    const html = '<a href="/about">About</a><a href="mailto:test@example.com">Email</a><a href="https://example.com/pricing#top">Pricing</a>';
    expect(extractLinks(html, 'https://example.com/')).toEqual([
      'https://example.com/about',
      'https://example.com/pricing',
    ]);
  });

  it('decodes an HTML-entity-encoded query string instead of mangling it into the wrong parameter', () => {
    // `&amp;` joining query parameters is ordinary, valid HTML (any
    // hand-written or CMS-templated link) -- the URL constructor doesn't
    // decode entities on its own, so without decoding first, "a=1&amp;b=2"
    // becomes the single parameter "a=1&amp;b" set to "2", not two params.
    const html = '<a href="/gallery?page=2&amp;category=weddings">Next</a>';
    expect(extractLinks(html, 'https://example.com/')).toEqual([
      'https://example.com/gallery?page=2&category=weddings',
    ]);
  });
});
