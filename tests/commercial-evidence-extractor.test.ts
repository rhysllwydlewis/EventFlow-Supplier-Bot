import { describe, expect, it } from 'vitest';
import type { SiteCrawlResult } from '../src/crawler/site-crawler.js';
import { extractCommercialEvidence } from '../src/extraction/commercial-evidence-extractor.js';

function crawl(html: string, url = 'https://supplier.example/packages'): SiteCrawlResult {
  return {
    rootUrl: 'https://supplier.example/',
    finalRootUrl: 'https://supplier.example/',
    pages: [{ url, contentType: 'text/html', html, bytes: Buffer.byteLength(html) }],
    failures: [],
  };
}

describe('commercial evidence extraction', () => {
  it('captures a named package with price qualifiers and nearby inclusions', () => {
    const result = extractCommercialEvidence(crawl(`
      <section class="package-card">
        <h2>Classic Wedding Package</h2>
        <p>From £4,995 + VAT</p>
        <ul><li>Venue hire</li><li>Three-course wedding breakfast</li></ul>
      </section>
    `));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kindHint: 'advertised_package',
      sourceUrl: 'https://supplier.example/packages',
    });
    expect(result[0]?.priceTokens).toContain('From £4,995 + VAT');
    expect(result[0]?.excerpt).toContain('Classic Wedding Package');
    expect(result[0]?.excerpt).toContain('Venue hire');
  });

  it('captures a clearly priced service without inventing a package label', () => {
    const result = extractCommercialEvidence(crawl(`
      <main>
        <h2>Wedding Photography</h2>
        <p>Full-day coverage from £1,250</p>
      </main>
    `));

    expect(result).toHaveLength(1);
    expect(result[0]?.kindHint).toBe('priced_service');
    expect(result[0]?.priceTokens).toContain('from £1,250');
  });

  it('preserves per-person, range and minimum-spend wording as evidence', () => {
    const result = extractCommercialEvidence(crawl(`
      <table>
        <tr><th>Wedding breakfast</th><td>£95 per person</td></tr>
        <tr><th>Evening package</th><td>£750–£950</td></tr>
        <tr><th>Exclusive hire</th><td>Minimum spend £6,000</td></tr>
      </table>
    `));

    const tokens = result.flatMap(item => item.priceTokens);
    expect(tokens).toContain('£95 per person');
    expect(tokens).toContain('£750–£950');
    expect(tokens).toContain('Minimum spend £6,000');
  });

  it('rejects a deposit-only commercial value', () => {
    const result = extractCommercialEvidence(crawl(`
      <section>
        <h2>Booking information</h2>
        <p>A £250 deposit is required to reserve your date.</p>
      </section>
    `));
    expect(result).toEqual([]);
  });

  it('does not merge two adjacent offerings into one evidence block', () => {
    const result = extractCommercialEvidence(crawl(`
      <section>
        <h2>Basic Package</h2>
        <p>£100</p>
        <h2>Premium Package</h2>
        <p>£200</p>
      </section>
    `));

    const basic = result.find(item => item.excerpt.includes('Basic Package'));
    const premium = result.find(item => item.excerpt.includes('Premium Package'));
    expect(basic?.excerpt).not.toContain('Premium Package');
    expect(basic?.excerpt).not.toContain('£200');
    expect(premium?.excerpt).not.toContain('Basic Package');
    expect(premium?.excerpt).not.toContain('£100');
  });

  it('rejects a deposit mention on a named package when no distinct full price is stated', () => {
    const result = extractCommercialEvidence(crawl(`
      <section>
        <h2>Wedding Package</h2>
        <p>£250 deposit required to secure your date.</p>
      </section>
    `));
    expect(result).toEqual([]);
  });

  it('keeps a deposit mention when a distinct full price is also present', () => {
    const result = extractCommercialEvidence(crawl(`
      <section>
        <h2>Wedding Package</h2>
        <p>£2,500 total, £250 deposit to secure your date.</p>
      </section>
    `));
    expect(result).toHaveLength(1);
    expect(result[0]?.priceTokens).toContain('£2,500');
  });

  it('records official linked PDF brochures as hints without treating them as parsed pricing evidence', () => {
    const result = extractCommercialEvidence(crawl(`
      <section>
        <h2>Wedding Package</h2>
        <p>From £3,500</p>
        <a href="/downloads/wedding-prices-2026.pdf">Download our 2026 wedding brochure</a>
      </section>
    `));
    expect(result[0]?.pdfLinks).toEqual(['https://supplier.example/downloads/wedding-prices-2026.pdf']);
  });
});
