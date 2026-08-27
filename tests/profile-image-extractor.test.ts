import { describe, expect, it } from 'vitest';
import type { SiteCrawlResult } from '../src/crawler/site-crawler.js';
import { extractSupplierProfileImage } from '../src/extraction/profile-image-extractor.js';

function crawl(html: string, pageUrl = 'https://venue.example/'): SiteCrawlResult {
  return {
    rootUrl: 'https://venue.example/',
    finalRootUrl: 'https://venue.example/',
    pages: [{ url: pageUrl, contentType: 'text/html', html, bytes: Buffer.byteLength(html) }],
    failures: [],
  };
}

describe('supplier profile image extraction', () => {
  it('prefers an official navbar logo while leaving venue photography to the media extractor', () => {
    const result = extractSupplierProfileImage(crawl(`
      <header class="site-header">
        <nav class="navbar">
          <a href="/"><img class="navbar-brand-logo" src="/assets/hensol-castle-logo.svg" alt="Hensol Castle" width="360" height="120"></a>
        </nav>
      </header>
      <main><img src="/gallery/castle-exterior.jpg" alt="Castle exterior" width="1600" height="900"></main>
    `));

    expect(result).toMatchObject({
      url: 'https://venue.example/assets/hensol-castle-logo.svg',
      sameSite: true,
    });
    expect(result?.score).toBeGreaterThanOrEqual(90);
    expect(result?.alt).toContain('Official business logo');
  });

  it('uses Organization/LocalBusiness structured-data logo declarations even when hosted on a CDN', () => {
    const result = extractSupplierProfileImage(crawl(`
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"LocalBusiness","name":"Venue Example","logo":{"url":"https://cdn.example.net/brand/venue-mark.png"}}
      </script>
    `));

    expect(result).toMatchObject({
      url: 'https://cdn.example.net/brand/venue-mark.png',
      sameSite: false,
    });
    expect(result?.score).toBeGreaterThanOrEqual(90);
  });

  it('rejects social, review and payment branding even when it appears in a header', () => {
    const result = extractSupplierProfileImage(crawl(`
      <header>
        <img src="/icons/facebook-logo.svg" alt="Facebook logo" width="80" height="80">
        <img src="/badges/trustpilot-logo.svg" alt="Trustpilot logo" width="240" height="80">
        <img src="/payments/visa-logo.svg" alt="Visa logo" width="160" height="50">
      </header>
    `));

    expect(result).toBeNull();
  });

  it('rewards the same brand asset repeated across crawled pages', () => {
    const html = '<header><img class="brand-logo" src="/assets/logo.png" alt="Venue Example" width="320" height="120"></header>';
    const result = extractSupplierProfileImage({
      rootUrl: 'https://venue.example/',
      finalRootUrl: 'https://venue.example/',
      pages: [
        { url: 'https://venue.example/', contentType: 'text/html', html, bytes: html.length },
        { url: 'https://venue.example/contact', contentType: 'text/html', html, bytes: html.length },
        { url: 'https://venue.example/weddings', contentType: 'text/html', html, bytes: html.length },
      ],
      failures: [],
    });

    expect(result?.url).toBe('https://venue.example/assets/logo.png');
    expect(result?.score).toBe(100);
  });
});
