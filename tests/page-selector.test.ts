import { describe, expect, it } from 'vitest';
import { selectUsefulPages } from '../src/crawler/page-selector.js';

describe('useful page selection', () => {
  it('prioritises commercial supplier pages and excludes obvious low-value paths', () => {
    const pages = selectUsefulPages('https://example.com/', [
      '/blog/post-one',
      '/about-us',
      '/wedding-packages',
      '/pricing',
      '/privacy-policy',
      'https://other.example/contact',
    ]);
    expect(pages[0]).toBe('https://example.com/');
    expect(pages).toContain('https://example.com/wedding-packages');
    expect(pages).toContain('https://example.com/pricing');
    expect(pages.some(item => item.includes('/privacy'))).toBe(false);
    expect(pages.some(item => item.startsWith('https://other.example'))).toBe(false);
  });
});
