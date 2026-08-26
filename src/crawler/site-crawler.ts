import { extractLinks } from './html-links.js';
import { selectUsefulPages } from './page-selector.js';
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

export async function crawlSupplierSite(rootUrl: string, maxPages = 8): Promise<SiteCrawlResult> {
  const root = await safeFetchText(rootUrl);
  const discoveredLinks = extractLinks(root.body, root.finalUrl);
  const selected = selectUsefulPages(root.finalUrl, discoveredLinks, maxPages);
  const pages: CrawledPage[] = [{
    url: root.finalUrl,
    contentType: root.contentType,
    html: root.body,
    bytes: root.bytes,
  }];
  const failures: Array<{ url: string; error: string }> = [];

  for (const url of selected) {
    if (url === root.finalUrl || pages.length >= maxPages) {
      continue;
    }
    try {
      const response = await safeFetchText(url);
      pages.push({
        url: response.finalUrl,
        contentType: response.contentType,
        html: response.body,
        bytes: response.bytes,
      });
    } catch (error) {
      failures.push({
        url,
        error: error instanceof Error ? error.message : 'Unknown crawl error',
      });
    }
  }

  return {
    rootUrl,
    finalRootUrl: root.finalUrl,
    pages,
    failures,
  };
}
