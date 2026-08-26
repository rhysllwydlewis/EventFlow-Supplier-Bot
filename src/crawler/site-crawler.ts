import { extractLinks } from './html-links.js';
import { selectUsefulPages } from './page-selector.js';
import { extractSitemapUrls, fetchRobotsPolicy, robotsAllows } from './robots.js';
import { safeFetchText } from './safe-fetch.js';

export interface CrawledPage {
  url: string;
  contentType: string;
  html: string;
  bytes: number;
}

export interface SiteCrawlResult {
  rootUrl: string;
  finalRootUrl: string;
  pages: CrawledPage[];
  failures: Array<{ url: string; error: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sitemapLinks(policyOrigin: URL, sitemaps: string[], crawlDelayMs: number): Promise<string[]> {
  const candidates = sitemaps.length ? sitemaps.slice(0, 2) : [new URL('/sitemap.xml', policyOrigin).href];
  const links: string[] = [];
  for (const sitemap of candidates) {
    try {
      await sleep(crawlDelayMs);
      const response = await safeFetchText(sitemap, {
        maxBytes: 2 * 1024 * 1024,
        allowedContentTypes: ['application/xml', 'text/xml', 'text/plain', 'application/xhtml+xml'],
      });
      for (const value of extractSitemapUrls(response.body, response.finalUrl, 250)) {
        try {
          const parsed = new URL(value);
          if (parsed.origin === policyOrigin.origin) links.push(parsed.href);
        } catch {
          // Ignore malformed or non-web sitemap entries.
        }
      }
    } catch {
      // Sitemaps are an optional discovery enhancement, not a crawl requirement.
    }
  }
  return [...new Set(links)];
}

export async function crawlSupplierSite(rootUrl: string, maxPages = 8): Promise<SiteCrawlResult> {
  const requested = new URL(rootUrl);
  let policy = await fetchRobotsPolicy(requested);
  if (!robotsAllows(policy, requested)) {
    throw new Error('Crawler blocked by robots.txt for requested supplier URL');
  }

  await sleep(policy.crawlDelayMs);
  const root = await safeFetchText(rootUrl);
  const finalRoot = new URL(root.finalUrl);
  if (finalRoot.origin !== requested.origin) {
    policy = await fetchRobotsPolicy(finalRoot);
  }
  if (!robotsAllows(policy, finalRoot)) {
    throw new Error('Crawler blocked by robots.txt after redirect');
  }

  const internalLinks = extractLinks(root.body, root.finalUrl);
  const fromSitemap = await sitemapLinks(finalRoot, policy.sitemaps, policy.crawlDelayMs);
  const selected = selectUsefulPages(root.finalUrl, [...internalLinks, ...fromSitemap], maxPages)
    .filter(url => robotsAllows(policy, url));
  const pages: CrawledPage[] = [{
    url: root.finalUrl,
    contentType: root.contentType,
    html: root.body,
    bytes: root.bytes,
  }];
  const failures: Array<{ url: string; error: string }> = [];

  for (const url of selected) {
    if (url === root.finalUrl || pages.length >= maxPages) continue;
    try {
      await sleep(policy.crawlDelayMs);
      const response = await safeFetchText(url);
      pages.push({ url: response.finalUrl, contentType: response.contentType, html: response.body, bytes: response.bytes });
    } catch (error) {
      failures.push({ url, error: error instanceof Error ? error.message : 'Unknown crawl error' });
    }
  }

  return { rootUrl, finalRootUrl: root.finalUrl, pages, failures };
}
