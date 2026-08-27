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
      <title>Wedding Venue | Hensol Castle</title>
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

  it('accepts a strongly branded extensionless navbar image URL', () => {
    const result = extractSupplierProfileImage(crawl(`
      <meta property="og:site_name" content="Venue Example">
      <header><img class="site-brand-logo" src="https://venue.example/media/logo?id=123" alt="Venue Example" width="320" height="120"></header>
    `));

    expect(result?.url).toBe('https://venue.example/media/logo?id=123');
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

  it('does not mistake a decorative logo-shape asset outside the header for the business logo', () => {
    const result = extractSupplierProfileImage(crawl(`
      <title>South Wales Castle Wedding Venue | Hensol Castle</title>
      <main>
        <img src="/images/logoshape-sidewaysregular.svg" width="180" height="60">
        <img src="/gallery/hensol-castle-exterior.jpg" alt="Hensol Castle Exterior" width="1600" height="900">
      </main>
    `));

    expect(result).toBeNull();
  });

  it('does not treat a generic promotional header photograph as a logo', () => {
    const result = extractSupplierProfileImage(crawl(`
      <title>Venue Example</title>
      <header>
        <img src="/promotions/wedding-fayre.jpg" alt="Wedding Fayre" width="260" height="130">
      </header>
    `));

    expect(result).toBeNull();
  });

  it('can use a business-name-matched header image even when the word logo is absent', () => {
    const result = extractSupplierProfileImage(crawl(`
      <meta property="og:site_name" content="Venue Example">
      <header><img src="/assets/masthead.svg" alt="Venue Example" width="320" height="120"></header>
    `));

    expect(result?.url).toBe('https://venue.example/assets/masthead.svg');
    expect(result?.score).toBeGreaterThanOrEqual(76);
  });

  it('detects strongly branded inline header background images', () => {
    const result = extractSupplierProfileImage(crawl(`
      <header><a class="site-logo" style="background-image:url('/assets/venue-logo.svg')" aria-label="Venue Example"></a></header>
    `));

    expect(result?.url).toBe('https://venue.example/assets/venue-logo.svg');
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
