import { describe, expect, it } from 'vitest';
import {
  crawlMentionsLocation,
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

  it('requires pages to mention the profile\'s town when one is recorded', () => {
    const pages = [{ url: 'u', text: 'Catering in Cardiff and the Vale' }];
    expect(crawlMentionsLocation('Cardiff, Wales', pages)).toBe(true);
    expect(crawlMentionsLocation('Swansea', pages)).toBe(false);
    expect(crawlMentionsLocation(null, pages)).toBe(true);
  });

  it('builds a quoted name + location query without stray quotes', () => {
    expect(sourceSearchQuery('Joe "Bar"', 'Cardiff')).toBe('"Joe  Bar" Cardiff');
    expect(sourceSearchQuery('Joe', null)).toBe('"Joe"');
  });
});
