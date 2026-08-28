import { describe, expect, it } from 'vitest';
import { evaluateDiscoverySearchResult } from '../src/services/discovery-result-quality.service.js';

function result(url: string, title: string, snippet?: string) {
  return { url, title, ...(snippet ? { snippet } : {}), rank: 1 };
}

describe('supplier discovery quality gate', () => {
  it('rejects directory and editorial domains seen in the Phase 3 pilot', () => {
    for (const item of [
      result('https://www.hitched.co.uk/wedding-venues/', 'Wedding Venues in South Wales'),
      result('https://bridebook.com/uk/search/wedding-venues/south-wales', 'South Wales Wedding Venues - Compare Prices & Reviews'),
      result('https://www.visitwales.com/things-do/weddings/venues', 'Memorable Welsh wedding venues | Visit Wales'),
      result('https://www.goodhotelguide.com/wedding-venues/south-wales/', 'Best hotel wedding venues in South Wales - Good Hotel Guide'),
    ]) {
      expect(evaluateDiscoverySearchResult(item, 'Venues')).toMatchObject({
        eligible: false,
        reason: 'directory_or_editorial_domain',
      });
    }
  });

  it('rejects government and public-body domains regardless of title wording', () => {
    for (const item of [
      result('https://cadw.gov.wales/visit/castles-monuments', 'Weddings at Cadw historic sites'),
      result('https://www.gov.uk/wedding-venues', 'Approved premises for weddings'),
    ]) {
      expect(evaluateDiscoverySearchResult(item, 'Venues')).toMatchObject({
        eligible: false,
        reason: 'government_domain',
      });
    }
  });

  it('rejects forum and UGC platforms', () => {
    expect(
      evaluateDiscoverySearchResult(
        result('https://www.reddit.com/r/weddingsuk/comments/abc123/', 'Best South Wales wedding venue?'),
        'Venues',
      ),
    ).toMatchObject({ eligible: false, reason: 'directory_or_editorial_domain' });
  });

  it('rejects Bridebook on its real .co.uk domain, not just .com', () => {
    expect(
      evaluateDiscoverySearchResult(
        result('https://bridebook.co.uk/uk/search/wedding-venues/south-wales', 'South Wales Wedding Venues - Compare Prices & Reviews | Bridebook'),
        'Venues',
      ),
    ).toMatchObject({ eligible: false, reason: 'directory_or_editorial_domain' });
  });

  it('rejects roundup titles that describe venues without using the word "venue"', () => {
    expect(
      evaluateDiscoverySearchResult(
        result('https://example.co.uk/weddings/south-wales', 'Wedding Venues in South Wales: 16 of the Best Places to Get Married'),
        'Venues',
      ),
    ).toMatchObject({ eligible: false, reason: 'editorial_result' });
  });

  it('keeps a genuine single-venue title that happens to use the same wording as roundups', () => {
    expect(
      evaluateDiscoverySearchResult(
        result('https://examplecastle.co.uk/weddings', 'The Perfect Place to Get Married in Wales | Example Castle'),
        'Venues',
      ),
    ).toMatchObject({ eligible: true });
  });

  it('rejects listicles and editorial article paths even on otherwise valid supplier domains', () => {
    expect(
      evaluateDiscoverySearchResult(
        result(
          'https://christopherpaulphotography.co.uk/blog/south-wales-wedding-venues',
          'My Top 10 South Wales Wedding Venues | Christopher Paul Photography',
        ),
        'Venues',
      ),
    ).toMatchObject({ eligible: false, reason: 'editorial_result' });

    expect(
      evaluateDiscoverySearchResult(
        result('https://example.co.uk/weddings', 'Affordable Wedding Venues in South Wales'),
        'Venues',
      ),
    ).toMatchObject({ eligible: false, reason: 'editorial_result' });
  });

  it('rejects a different supplier category being returned for a venue search', () => {
    expect(
      evaluateDiscoverySearchResult(
        result(
          'https://southwalesphotos.example/services',
          'South Wales Wedding Photographer',
          'Documentary wedding photography across Cardiff and the Valleys.',
        ),
        'Venues',
      ),
    ).toMatchObject({ eligible: false, reason: 'category_mismatch' });
  });

  it('keeps genuine venue service pages', () => {
    for (const item of [
      result('https://llanerch.co.uk/weddings', 'Llanerch Vineyard | Wedding Venue South Wales'),
      result('https://www.brynmeadows.co.uk/weddings/', 'Weddings at Bryn Meadows Hotel & Spa'),
      result('https://talljohnshouse.com/weddings', "Weddings | Tall John's House"),
      result('https://examplecastle.co.uk/wedding-venue', 'Example Castle Wedding Venue'),
    ]) {
      expect(evaluateDiscoverySearchResult(item, 'Venues')).toMatchObject({ eligible: true });
    }
  });

  it('rejects malformed URLs without throwing', () => {
    expect(evaluateDiscoverySearchResult(result('not-a-url', 'Venue'), 'Venues')).toEqual({
      eligible: false,
      reason: 'invalid_url',
    });
  });
});
