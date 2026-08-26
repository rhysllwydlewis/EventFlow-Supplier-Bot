import { describe, expect, it } from 'vitest';
import { extractSitemapUrls, parseRobots, robotsAllows } from '../src/crawler/robots.js';

describe('robots and sitemap policy', () => {
  it('prefers EventFlowBot-specific rules over wildcard rules', () => {
    const policy = parseRobots(`
User-agent: *
Disallow: /private

User-agent: EventFlowBot
Disallow: /admin
Allow: /admin/public
Crawl-delay: 2
Sitemap: https://example.com/sitemap.xml
`, 'https://example.com/robots.txt');
    expect(robotsAllows(policy, 'https://example.com/private')).toBe(true);
    expect(robotsAllows(policy, 'https://example.com/admin/secret')).toBe(false);
    expect(robotsAllows(policy, 'https://example.com/admin/public')).toBe(true);
    expect(policy.crawlDelayMs).toBe(2000);
    expect(policy.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('uses the longest matching rule and allow on ties', () => {
    const policy = parseRobots('User-agent: *\nDisallow: /packages\nAllow: /packages/public', 'https://example.com/robots.txt');
    expect(robotsAllows(policy, 'https://example.com/packages/private')).toBe(false);
    expect(robotsAllows(policy, 'https://example.com/packages/public')).toBe(true);
  });

  it('extracts and deduplicates sitemap locations', () => {
    const urls = extractSitemapUrls('<urlset><url><loc>https://example.com/about</loc></url><url><loc>/pricing?x=1&amp;y=2</loc></url><url><loc>https://example.com/about</loc></url></urlset>', 'https://example.com/sitemap.xml');
    expect(urls).toEqual(['https://example.com/about', 'https://example.com/pricing?x=1&y=2']);
  });
});
