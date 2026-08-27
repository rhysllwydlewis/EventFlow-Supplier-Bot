import { describe, expect, it } from 'vitest';
import type { SiteCrawlResult } from '../src/crawler/site-crawler.js';
import { extractSupplierMedia } from '../src/extraction/image-extractor.js';

function crawl(html: string, pageUrl = 'https://venue.example/weddings'): SiteCrawlResult {
  return {
    rootUrl: 'https://venue.example/',
    finalRootUrl: 'https://venue.example/',
    pages: [{ url: pageUrl, contentType: 'text/html', html, bytes: Buffer.byteLength(html) }],
    failures: [],
  };
}

describe('supplier media extraction', () => {
  it('ranks publisher-declared hero images and useful same-site venue photos', () => {
    const result = extractSupplierMedia(crawl(`
      <html><head>
        <meta property="og:image" content="https://cdn.example-cms.com/venue/hero-wedding.jpg">
      </head><body>
        <img src="/media/ceremony-room.webp" alt="Wedding ceremony room" width="1600" height="900">
        <img src="/assets/logo.svg" alt="Venue logo" width="500" height="200">
      </body></html>
    `));

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      url: 'https://cdn.example-cms.com/venue/hero-wedding.jpg',
      kind: 'open_graph',
    });
    expect(result.some(item => item.url === 'https://venue.example/media/ceremony-room.webp')).toBe(true);
    expect(result.some(item => item.url.includes('logo.svg'))).toBe(false);
  });

  it('rejects unrelated third-party inline images but permits an explicit OpenGraph CDN image', () => {
    const result = extractSupplierMedia(crawl(`
      <meta property="og:image" content="https://images.cdn.test/official-venue-hero.jpg">
      <img src="https://ads.example.net/banner.jpg" alt="Wedding venue banner" width="1200" height="600">
      <img src="/gallery/reception.jpg" alt="Reception room" width="1200" height="800">
    `));

    expect(result.map(item => item.url)).toContain('https://images.cdn.test/official-venue-hero.jpg');
    expect(result.map(item => item.url)).toContain('https://venue.example/gallery/reception.jpg');
    expect(result.map(item => item.url)).not.toContain('https://ads.example.net/banner.jpg');
  });

  it('selects the largest srcset candidate and filters tiny/tracking assets', () => {
    const result = extractSupplierMedia(crawl(`
      <img src="/gallery/small.jpg" srcset="/gallery/small.jpg 400w, /gallery/large.jpg 1600w" alt="Venue grounds">
      <img src="/tracking/pixel.png" width="1" height="1">
      <img src="/icons/arrow.png" width="24" height="24">
    `));

    expect(result.map(item => item.url)).toEqual(['https://venue.example/gallery/large.jpg']);
  });

  it('discovers common inline-style hero backgrounds on non-image elements', () => {
    const result = extractSupplierMedia(crawl(`
      <section aria-label="Wedding venue hero" style="background-image: url('/media/wedding-hero.jpg'); min-height: 600px"></section>
      <div style="background:url(https://ads.example.net/banner.jpg)"></div>
    `));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      url: 'https://venue.example/media/wedding-hero.jpg',
      kind: 'background_image',
      sameSite: true,
    });
  });

  it('does not fail the supplier pipeline on malformed percent escapes in an image path', () => {
    expect(() => extractSupplierMedia(crawl(`
      <img src="/gallery/%E0%A4%A-wedding-venue.jpg" alt="Wedding venue" width="1400" height="800">
    `))).not.toThrow();
  });

  it('deduplicates an image referenced on several crawled pages', () => {
    const html = '<img src="/media/venue-exterior.jpg" alt="Venue exterior" width="1400" height="800">';
    const result = extractSupplierMedia({
      rootUrl: 'https://venue.example/',
      finalRootUrl: 'https://venue.example/',
      pages: [
        { url: 'https://venue.example/', contentType: 'text/html', html, bytes: html.length },
        { url: 'https://venue.example/weddings', contentType: 'text/html', html, bytes: html.length },
      ],
      failures: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe('https://venue.example/media/venue-exterior.jpg');
  });
});
