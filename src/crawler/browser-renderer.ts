import { chromium, type BrowserContext, type Page } from 'playwright';
import { env } from '../config/env.js';
import { startSsrfSafeProxy } from './browser-network-proxy.js';
import { extractLinks } from './html-links.js';
import { assertCrawlableUrl, resolvePublicAddresses } from './network-policy.js';
import { selectUsefulPages } from './page-selector.js';
import { fetchRobotsPolicy, robotsAllows, type RobotsPolicy } from './robots.js';
import type { CrawledPage, SiteCrawlResult } from './site-crawler.js';

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'websocket', 'eventsource']);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Defense-in-depth only: the actual SSRF guarantee comes from routing the
// whole browser context through the SSRF-safe proxy (see
// crawlSupplierSiteWithBrowser), which re-resolves and pins every connection
// immediately before opening it. This route handler runs *before* Chromium
// even reaches the proxy, so it still saves bandwidth by aborting blocked
// resource types early and fails fast on obviously-unsafe request URLs.
async function installNetworkGuard(context: BrowserContext): Promise<void> {
  await context.route('**/*', async route => {
    const request = route.request();
    const resourceType = request.resourceType();
    if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
      await route.abort();
      return;
    }

    try {
      assertCrawlableUrl(request.url());
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

    // page.url() already reflects the post-redirect destination as soon as
    // goto() resolves -- checking robots.txt here, before letting the page
    // settle further, avoids driving any *additional* activity (JS-triggered
    // requests during the networkidle wait, the full rendered content
    // extraction below) against a final URL that turns out to be
    // robots-disallowed. The initial document fetch itself is unavoidable:
    // Chromium's redirect chain isn't observable to know the final URL
    // without letting navigation complete, but nothing past that is owed to
    // a disallowed page.
    const finalUrl = assertCrawlableUrl(page.url());
    await resolvePublicAddresses(finalUrl);
    const finalPolicy = finalUrl.origin === target.origin ? policy : await fetchRobotsPolicy(finalUrl);
    if (!robotsAllows(finalPolicy, finalUrl)) {
      throw new Error('Browser crawler blocked by robots.txt after redirect');
    }

    await page.waitForLoadState('networkidle', { timeout: env.BROWSER_RENDER_SETTLE_MS }).catch(() => undefined);
    await page.waitForTimeout(Math.min(env.BROWSER_RENDER_SETTLE_MS, 2_500));

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

  // Each resource is opened and released in its own try/finally, nested
  // innermost-last, so a failure partway through setup (e.g. the browser
  // launches but the context fails to open) still releases everything
  // that *did* open rather than leaking the proxy's listening socket or
  // the browser process.
  const proxy = await startSsrfSafeProxy();
  try {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: !env.BROWSER_ALLOW_NO_SANDBOX,
      proxy: { server: `http://127.0.0.1:${proxy.port}` },
      // Chromium implicitly bypasses the proxy for loopback destinations
      // unless told otherwise -- without this, a request to 127.0.0.1 would
      // skip the proxy (and its SSRF checks) entirely and connect directly.
      // Passed as a raw launch arg rather than Playwright's proxy.bypass
      // option, which documents itself as a comma-separated domain list and
      // is not guaranteed to forward Chromium's special "<-loopback>" bypass
      // syntax unmodified.
      args: ['--proxy-bypass-list=<-loopback>'],
    });
    try {
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
      }
    } finally {
      await browser.close();
    }
  } finally {
    await proxy.close();
  }
}
