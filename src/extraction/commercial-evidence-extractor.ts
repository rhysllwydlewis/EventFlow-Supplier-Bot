import type { SiteCrawlResult } from '../crawler/site-crawler.js';

const PRICE_TOKEN_RE = /(?:\b(?:from|starting\s+(?:at|from)|minimum\s+spend(?:\s+of)?|prices?\s+from)\s+)?£\s?\d[\d,]*(?:\.\d{1,2})?(?:\s*(?:-|–|—|to)\s*£?\s?\d[\d,]*(?:\.\d{1,2})?)?(?:\s*(?:\+|plus)\s*VAT|\s*(?:inc(?:luding)?|incl\.?)\s*VAT|\s*(?:excl(?:uding)?|excl\.?)\s*VAT)?(?:\s*(?:per|\/)\s*(?:person|head|guest|hour|day|event|item|night))?/gi;
const PACKAGE_HINT_RE = /\b(package|packages|collection|collections|bundle|bundles|tier|tiers|option|options|menu|menus)\b/i;
const COMMERCIAL_HINT_RE = /\b(price|prices|pricing|rate|rates|cost|costs|hire|service|services|wedding|event|venue|photograph|video|cater|dj|music|flor|cake|decor|entertainment|ceremony|reception|room|session|coverage)\w*/i;
const DEPOSIT_ONLY_RE = /\b(deposit|booking\s+fee|reservation\s+fee|retainer|instalment|installment|monthly\s+payment|finance)\b/i;
const PDF_LINK_RE = /<a\b[^>]*href\s*=\s*["']([^"']+\.pdf(?:[?#][^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;

export type CommercialEvidenceKind = 'advertised_package' | 'priced_service';

export interface CommercialEvidenceCandidate {
  sourceUrl: string;
  kindHint: CommercialEvidenceKind;
  excerpt: string;
  rawForHash: string;
  priceTokens: string[];
  pdfLinks: string[];
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&pound;/gi, '£')
    .replace(/&#163;/gi, '£')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function structuredText(html: string): string[] {
  const value = decodeEntities(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:h[1-6]|p|li|div|section|article|tr|table|ul|ol|dl|dt|dd)>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '\n');

  return value
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, ' ').replace(/\s*\|\s*/g, ' | ').trim())
    .filter(Boolean)
    .filter(line => line.length <= 2_500);
}

function unique(values: string[], max = 20): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, max);
}

function extractPdfLinks(html: string, pageUrl: string): string[] {
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = PDF_LINK_RE.exec(html)) && links.length < 12) {
    try {
      const url = new URL(match[1] || '', pageUrl);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      url.hash = '';
      links.push(url.href);
    } catch {
      // Malformed brochure links are ignored rather than failing supplier extraction.
    }
  }
  return unique(links, 12);
}

function priceTokens(value: string): string[] {
  return unique(value.match(PRICE_TOKEN_RE) ?? [], 12);
}

function meaningfulWords(value: string): number {
  return (value.match(/[A-Za-z]{3,}/g) ?? []).length;
}

function candidateWindow(lines: string[], index: number): string {
  const start = Math.max(0, index - 2);
  const end = Math.min(lines.length, index + 4);
  return lines.slice(start, end).join('\n').slice(0, 2_000).trim();
}

function isUsefulCommercialBlock(block: string, prices: string[]): boolean {
  if (!prices.length || meaningfulWords(block) < 3) return false;
  if (!COMMERCIAL_HINT_RE.test(block) && !PACKAGE_HINT_RE.test(block)) return false;

  // Deposit/finance values are not publishable package prices on their own.
  // They may still be present in a valid block when a separate full price is also stated.
  if (DEPOSIT_ONLY_RE.test(block) && prices.length === 1 && !/\b(total|full|package|hire|service|from)\b/i.test(block)) {
    return false;
  }
  return true;
}

export function extractCommercialEvidence(crawl: SiteCrawlResult): CommercialEvidenceCandidate[] {
  const candidates: CommercialEvidenceCandidate[] = [];
  const seen = new Set<string>();

  for (const page of crawl.pages) {
    const lines = structuredText(page.html);
    const pdfLinks = extractPdfLinks(page.html, page.url);

    for (let index = 0; index < lines.length; index += 1) {
      const linePrices = priceTokens(lines[index] || '');
      if (!linePrices.length) continue;

      const block = candidateWindow(lines, index);
      const prices = priceTokens(block);
      if (!isUsefulCommercialBlock(block, prices)) continue;

      const normalized = `${page.url}\n${block.toLowerCase().replace(/\s+/g, ' ')}`;
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      candidates.push({
        sourceUrl: page.url,
        kindHint: PACKAGE_HINT_RE.test(block) ? 'advertised_package' : 'priced_service',
        excerpt: block,
        rawForHash: block,
        priceTokens: prices,
        pdfLinks,
      });
      if (candidates.length >= 30) return candidates;
    }
  }

  return candidates;
}
