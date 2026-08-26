import { chromium, type BrowserContext, type Page } from 'playwright';
import { env } from '../config/env.js';
import { extractLinks } from './html-links.js';
import { assertCrawlableUrl, resolvePublicAddresses } from './network-policy.js';
import { selectUsefulPages } from './page-selector.js';
import { fetchRobotsPolicy, robotsAllows, type RobotsPolicy } from './robots.js';
import type { CrawledPage, SiteCrawlResult } from './site-crawler.js';

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'websocket', 'eventsource']);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function installNetworkGuard(context: BrowserContext): Promise<void> {
  await context.route('**/*', async route => {
    const request = route.request();
    const resourceType = request.resourceType();
    if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
      await route.abort();
      return;
    }

    try {
      const url = assertCrawlableUrl(request.url());
      await resolvePublicAddresses(url);
      await route.continue();
    } catch {
      await route.abort();
    }
  });
}

async function renderOne(
  context: BrowserContext,
  url: string,
  policy: RobotsPolicy,
): Promise<CrawledPage> {
  const target = assertCrawlableUrl(url);
  await resolvePublicAddresses(target);
  if (!robotsAllows(policy, target)) {
    throw new Error(`Browser crawler blocked by robots.txt for ${target.href}`);
  }

  await sleep(policy.crawlDelayMs);
  const page: Page = await context.newPage();
  try {
    const response = await page.goto(target.href, {
      waitUntil: 'domcontentloaded',
      timeout: env.BROWSER_CRAWL_TIMEOUT_MS,
    });
    if (!response || response.status() < 200 || response.status() >= 400) {
      throw new Error(`Browser crawler received HTTP ${response?.status() ?? 'unknown'}`);
    }

    await page.waitForLoadState('networkidle', { timeout: env.BROWSER_RENDER_SETTLE_MS }).catch(() => undefined);
    await page.waitForTimeout(Math.min(env.BROWSER_RENDER_SETTLE_MS, 2_500));

    const finalUrl = assertCrawlableUrl(page.url());
    await resolvePublicAddresses(finalUrl);
    const finalPolicy = finalUrl.origin === target.origin ? policy : await fetchRobotsPolicy(finalUrl);
    if (!robotsAllows(finalPolicy, finalUrl)) {
      throw new Error('Browser crawler blocked by robots.txt after redirect');
    }

    const html = await page.content();
    const bytes = Buffer.byteLength(html, 'utf8');
    if (bytes > env.BROWSER_MAX_HTML_BYTES) {
      throw new Error(`Browser-rendered HTML exceeds ${env.BROWSER_MAX_HTML_BYTES} byte limit`);
    }
    return {
      url: finalUrl.href,
      contentType: 'text/html',
      html,
      bytes,
    };
  } finally {
    await page.close();
  }
}

export async function crawlSupplierSiteWithBrowser(
  rootUrl: string,
  maxPages = env.BROWSER_MAX_PAGES,
): Promise<SiteCrawlResult> {
  const requested = assertCrawlableUrl(rootUrl);
  const rootPolicy = await fetchRobotsPolicy(requested);
  if (!robotsAllows(rootPolicy, requested)) {
    throw new Error('Browser crawler blocked by robots.txt for requested supplier URL');
  }

  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: !env.BROWSER_ALLOW_NO_SANDBOX,
  });
  const context = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: 'block',
    userAgent: 'EventFlowBot/0.1 (+https://event-flow.co.uk/bot)',
  });

  try {
    await installNetworkGuard(context);
    const root = await renderOne(context, requested.href, rootPolicy);
    const finalRoot = new URL(root.url);
    const policy = finalRoot.origin === requested.origin ? rootPolicy : await fetchRobotsPolicy(finalRoot);
    const links = extractLinks(root.html, root.url);
    const selected = selectUsefulPages(root.url, links, Math.max(1, maxPages))
      .filter(value => robotsAllows(policy, value));

    const pages: CrawledPage[] = [root];
    const failures: Array<{ url: string; error: string }> = [];
    for (const url of selected) {
      if (url === root.url || pages.length >= maxPages) continue;
      try {
        pages.push(await renderOne(context, url, policy));
      } catch (error) {
        failures.push({
          url,
          error: error instanceof Error ? error.message : 'Unknown browser crawl error',
        });
      }
    }

    return {
      rootUrl,
      finalRootUrl: root.url,
      pages,
      failures,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}
