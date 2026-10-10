import { describe, expect, it } from 'vitest';
import {
  hostLooksLikeBusiness,
  isRecordedPageOrChild,
  pagesAboutBusiness,
  crawlNamesBusiness,
  isDirectorySourceUrl,
  pickSourceCandidate,
  significantNameTokens,
  sourceSearchQuery,
} from '../src/services/source-resolver.service.js';

const r = (url: string, title: string) => ({ url, title, rank: 1 });
const recorded = 'https://wedding-caterers.co.uk/near-me/cardiff';

describe('source resolver', () => {
  it('recognises third-party directory sources, including the discovery block list', () => {
    expect(isDirectorySourceUrl('https://www.poptop.uk.com/x')).toBe(true);
    expect(isDirectorySourceUrl('https://hitched.co.uk/x')).toBe(true);
    expect(isDirectorySourceUrl('https://cardiffcateringcompany.co.uk/')).toBe(false);
    expect(isDirectorySourceUrl('not a url')).toBe(false);
  });

  it('drops generic company words from the name tokens', () => {
    expect(significantNameTokens('The Cardiff Catering Company Ltd')).toEqual(['cardiff', 'catering', 'company']);
  });

  it('prefers the own site over a directory profile page', () => {
    const picked = pickSourceCandidate('Cardiff Catering Company', 'Catering', recorded, [
      r('https://poptop.uk.com/cardiff/suppliers/cardiff-catering-company', 'Cardiff Catering Company - PopTop'),
      r('https://cardiffcateringcompany.co.uk/', 'Cardiff Catering Company'),
    ]);
    expect(picked).toEqual({ url: 'https://cardiffcateringcompany.co.uk/', kind: 'own_site' });
  });

  it('falls back to a directory profile page when there is no own site', () => {
    const picked = pickSourceCandidate('Cardiff Catering Company', 'Catering', recorded, [
      r('https://poptop.uk.com/cardiff/suppliers/cardiff-catering-company', 'Cardiff Catering Company - PopTop'),
    ]);
    expect(picked?.kind).toBe('directory_profile');
  });

  it('requires the result title to name every significant word, and skips the recorded url, listings and editorial pages', () => {
    expect(
      pickSourceCandidate('Cardiff Catering Company', 'Catering', recorded, [
        r('https://other.test/', 'Cardiff Catering'),
        r(recorded, 'Cardiff Catering Company'),
        r('https://example.test/blog/cardiff-catering-company', 'Cardiff Catering Company'),
        r('https://hitched.co.uk/c', 'Cardiff Catering Company'),
        r('https://dir.test/near-me/cardiff', 'Cardiff Catering Company'),
      ]),
    ).toBeNull();
  });

  it('returns null for a name with no significant words', () => {
    expect(pickSourceCandidate('The Ltd', 'Catering', recorded, [r('https://a.test/', 'The Ltd')])).toBeNull();
  });

  it('verifies a crawled page names the business on a whole-word basis', () => {
    expect(crawlNamesBusiness('Cardiff Catering Company', [{ url: 'u', text: 'Welcome to Cardiff Catering Company!' }])).toBe(true);
    expect(crawlNamesBusiness('Cardiff Catering Company', [{ url: 'u', text: 'Cardiff caterers company' }])).toBe(false);
    expect(crawlNamesBusiness('Cardiff Catering Company', [])).toBe(false);
  });

  it('treats URL variants and children of the recorded listing as the listing itself', () => {
    const rec = 'https://poptop.uk.com/cardiff/catering/';
    for (const variant of [
      'https://poptop.uk.com/cardiff/catering',
      'http://www.poptop.uk.com/cardiff/catering/?page=2#x',
      'https://poptop.uk.com/cardiff/catering/weddings',
    ]) {
      expect(isRecordedPageOrChild(rec, variant), variant).toBe(true);
    }
    expect(isRecordedPageOrChild(rec, 'https://poptop.uk.com/cardiff/suppliers/x')).toBe(false);
    expect(isRecordedPageOrChild(rec, 'https://other.test/cardiff/catering')).toBe(false);
    expect(pickSourceCandidate('Cardiff Catering Company', 'Catering', rec, [
      r('https://www.poptop.uk.com/cardiff/catering?utm=1', 'Cardiff Catering Company'),
    ])).toBeNull();
  });

  it('only calls a source "own site" when its hostname itself carries the business name', () => {
    expect(hostLooksLikeBusiness('www.cardiffcateringcompany.co.uk', 'Cardiff Catering Company')).toBe(true);
    expect(hostLooksLikeBusiness('bark.com', 'Cardiff Catering Company')).toBe(false);
    const picked = pickSourceCandidate('Cardiff Catering Company', 'Catering', recorded, [
      r('https://bark.com/en/gb/cardiff-catering-company/', 'Cardiff Catering Company - Bark'),
    ]);
    expect(picked?.kind).toBe('directory_profile');
  });

  it('keeps only pages that individually name the business and its town', () => {
    const pages = [
      { url: 'a', text: 'Cardiff Catering Company, Penarth' },
      { url: 'b', text: 'Cardiff Catering Company' },
      { url: 'c', text: 'Penarth weddings roundup' },
    ];
    expect(pagesAboutBusiness('Cardiff Catering Company', 'Penarth, Wales', pages, p => p.text).map(p => p.url)).toEqual(['a']);
    expect(pagesAboutBusiness('Cardiff Catering Company', null, pages, p => p.text)).toEqual([]);
  });

  it('builds a quoted name + location query without stray quotes', () => {
    expect(sourceSearchQuery('Joe "Bar"', 'Cardiff')).toBe('"Joe  Bar" Cardiff');
    expect(sourceSearchQuery('Joe', null)).toBe('"Joe"');
  });
});
