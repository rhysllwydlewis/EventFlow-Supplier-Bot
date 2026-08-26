import type { SiteCrawlResult } from './site-crawler.js';
import type { BasicExtraction } from '../extraction/basic-extractor.js';

export interface BrowserFallbackDecision {
  required: boolean;
  reason: string | null;
}

const APP_SHELL_MARKERS = [
  '__next_data__',
  '__nuxt__',
  'id="root"',
  "id='root'",
  'id="app"',
  "id='app'",
  'data-reactroot',
  'ng-version=',
  'webpack',
  'vite',
];

export function assessBrowserFallback(
  crawl: SiteCrawlResult,
  extraction: BasicExtraction,
): BrowserFallbackDecision {
  const textChars = extraction.pageText.reduce((total, page) => total + page.text.length, 0);
  const rootHtml = (crawl.pages[0]?.html || '').toLowerCase();
  const appShell = APP_SHELL_MARKERS.some(marker => rootHtml.includes(marker));
  const hasUsefulFacts = Boolean(
    extraction.emails.length
    || extraction.phones.length
    || extraction.advertisedPrices.length
    || extraction.jsonLd.length,
  );

  if (crawl.pages.length <= 1 && appShell && textChars < 1_500) {
    return { required: true, reason: 'javascript_app_shell_with_sparse_static_content' };
  }

  if (!hasUsefulFacts && textChars < 350 && rootHtml.includes('<script')) {
    return { required: true, reason: 'static_html_contains_too_little_business_content' };
  }

  return { required: false, reason: null };
}
