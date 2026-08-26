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
});
