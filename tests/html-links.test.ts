import { describe, expect, it } from 'vitest';
import { extractLinks, extractLinksWithText } from '../src/crawler/html-links.js';

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

  it('does not let one call\'s early exit (maxLinks reached) corrupt the next call on different HTML', () => {
    // ANCHOR_RE is a shared module-level RegExp with the 'g' flag, whose
    // lastIndex persists across calls. A call that hits maxLinks before
    // exhausting its string leaves lastIndex pointing partway into *that*
    // string; without resetting it, the very next call -- on a different,
    // likely shorter, unrelated HTML string -- would start scanning from
    // the wrong offset and could silently return nothing at all.
    const first = '<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>';
    extractLinks(first, 'https://example.com/', 2);
    const second = '<a href="/x">X</a><a href="/y">Y</a>';
    expect(extractLinks(second, 'https://example.com/', 10)).toEqual([
      'https://example.com/x',
      'https://example.com/y',
    ]);
  });
});

describe('anchor text extraction', () => {
  it('captures visible link text alongside the href', () => {
    const html = '<a href="/w4">Weddings</a>';
    expect(extractLinksWithText(html, 'https://example.com/')).toEqual([
      { href: 'https://example.com/w4', text: 'Weddings' },
    ]);
  });

  it('strips inner markup and collapses whitespace, e.g. an icon span around the label', () => {
    const html = '<a href="/w4">\n  <span class="icon"></span>\n  Weddings\n</a>';
    const [link] = extractLinksWithText(html, 'https://example.com/');
    expect(link.text).toBe('Weddings');
  });

  it('decodes entities in link text the same way it does in hrefs', () => {
    const html = '<a href="/faq">FAQs &amp; Info</a>';
    const [link] = extractLinksWithText(html, 'https://example.com/');
    expect(link.text).toBe('FAQs & Info');
  });

  it('returns empty text for a link with no visible content, without throwing', () => {
    const html = '<a href="/icon-only"><svg></svg></a>';
    const [link] = extractLinksWithText(html, 'https://example.com/');
    expect(link.text).toBe('');
  });

  it('keeps the first-seen text when the same href appears more than once', () => {
    const html = '<a href="/w4">Weddings</a><a href="/w4">Book your day</a>';
    const links = extractLinksWithText(html, 'https://example.com/');
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('Weddings');
  });

  it('extractLinks stays href-only, dropping the text extractLinksWithText now carries', () => {
    const html = '<a href="/w4">Weddings</a>';
    expect(extractLinks(html, 'https://example.com/')).toEqual(['https://example.com/w4']);
  });
});
