import { describe, expect, it } from 'vitest';
import { pickNextPage, scoreUsefulPage, selectUsefulPages } from '../src/crawler/page-selector.js';

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

describe('anchor text as a scoring signal', () => {
  it('scores a page with no useful term in its path, but a matching visible link label, above zero', () => {
    // The real case this closes: a nav link like <a href="/w4">Weddings</a>
    // -- the path alone ("/w4") has nothing for scoreUsefulPage to match.
    const withoutText = scoreUsefulPage(new URL('https://example.com/w4'), 'https://example.com', undefined);
    const withText = scoreUsefulPage(new URL('https://example.com/w4'), 'https://example.com', 'Weddings');
    expect(withoutText).toBe(0);
    expect(withText).toBeGreaterThan(0);
  });

  it('still trusts a path match more than the same term only in link text', () => {
    const pathMatch = scoreUsefulPage(new URL('https://example.com/wedding-packages'), 'https://example.com');
    const textOnlyMatch = scoreUsefulPage(new URL('https://example.com/w4'), 'https://example.com', 'wedding packages');
    expect(pathMatch).toBeGreaterThan(textOnlyMatch);
  });

  it('excludes a low-value page via its link text even when the path itself looks neutral', () => {
    const score = scoreUsefulPage(new URL('https://example.com/p42'), 'https://example.com', 'Privacy Policy');
    expect(score).toBeLessThan(0);
  });

  it('ranks a text-only-scoring page above an equally neutral, textless one in the real selection path', () => {
    // Before anchor text was considered, /w4 and /team would tie at score 0
    // and the alphabetical tiebreak would put /team first -- silently
    // starving the real Weddings page of a crawl slot whenever the budget
    // was tight. With text considered, /w4 (Weddings) correctly outranks it.
    const pages = selectUsefulPages(
      'https://example.com/',
      ['/team', { href: '/w4', text: 'Weddings' }],
      10,
    );
    expect(pages).toContain('https://example.com/team');
    expect(pages.indexOf('https://example.com/w4')).toBeLessThan(pages.indexOf('https://example.com/team'));
  });

  it('pickNextPage picks the Weddings-labelled page over a same-scoring textless one', () => {
    const fetched = new Set(['https://example.com/']);
    const next = pickNextPage(
      'https://example.com/',
      ['/team', { href: '/w4', text: 'Weddings' }],
      fetched,
    );
    expect(next).toBe('https://example.com/w4');
  });
});

describe('incremental next-page selection', () => {
  it('skips pages already fetched and returns the next best-scoring candidate', () => {
    const fetched = new Set(['https://example.com/', 'https://example.com/about-us']);
    const next = pickNextPage(
      'https://example.com/',
      ['/about-us', '/wedding-packages', '/pricing'],
      fetched,
    );
    // wedding-packages hits both 'package' and 'packages' in
    // COMMERCIAL_PATH_TERMS plus 'wedding' in USEFUL_PATH_TERMS (score 85),
    // well above pricing's single COMMERCIAL_PATH_TERMS hit (score 35).
    expect(next).toBe('https://example.com/wedding-packages');
  });

  it('returns null once every scoring candidate has already been fetched', () => {
    const fetched = new Set(['https://example.com/', 'https://example.com/about-us']);
    const next = pickNextPage('https://example.com/', ['/about-us'], fetched);
    expect(next).toBeNull();
  });

  it('finds a page ranked below several already-fetched ones, not just the top scorer', () => {
    // Simulates the real crawl loop: after several rounds, every
    // top-scoring slot is already fetched, so pickNextPage must still
    // surface a lower-ranked (but still positive-scoring) candidate --
    // /services, the lowest-scoring survivor here -- rather than stopping
    // early the way a maxPages-capped selectUsefulPages call would.
    const candidates = [
      '/wedding-packages',
      '/pricing',
      '/menus',
      '/rates',
      '/brochure',
      '/about-us',
      '/services',
    ];
    const fetched = new Set([
      'https://example.com/',
      'https://example.com/wedding-packages',
      'https://example.com/pricing',
      'https://example.com/menus',
      'https://example.com/rates',
      'https://example.com/brochure',
      'https://example.com/about-us',
    ]);
    const next = pickNextPage('https://example.com/', candidates, fetched);
    expect(next).toBe('https://example.com/services');
  });

  it('honours a robots-allow predicate, skipping a disallowed higher-scoring candidate', () => {
    const fetched = new Set(['https://example.com/']);
    const next = pickNextPage(
      'https://example.com/',
      ['/pricing', '/wedding-packages'],
      fetched,
      url => !url.includes('wedding-packages'),
    );
    // wedding-packages would normally win on score alone; disallowing it
    // must fall through to the next-best allowed candidate, not null.
    expect(next).toBe('https://example.com/pricing');
  });
});
