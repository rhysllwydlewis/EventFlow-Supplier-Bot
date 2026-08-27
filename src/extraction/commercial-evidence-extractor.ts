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

interface StructuredLine {
  text: string;
  heading: boolean;
}

// Captured separately (by exact heading text) rather than woven into the
// same replace-chain that flattens the rest of the page: candidateWindow
// needs to know which output lines came from an <h1>-<h6> so it can treat
// them as offering boundaries, and that classification would otherwise be
// lost once tags are stripped.
function extractHeadingTexts(html: string): Set<string> {
  const headings = new Set<string>();
  const HEADING_RE = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let match: RegExpExecArray | null;
  while ((match = HEADING_RE.exec(html))) {
    const text = decodeEntities(match[1] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) headings.add(text);
  }
  return headings;
}

function structuredText(html: string): StructuredLine[] {
  const headingTexts = extractHeadingTexts(html);
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
    .filter(line => line.length <= 2_500)
    .map(text => ({ text, heading: headingTexts.has(text) }));
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

// Stops the window at another offering's boundary so two adjacent offerings
// (e.g. two package cards flattened into sequential lines) never get merged
// into one block. Without this, a name from one offering and a price from
// another can end up in the same excerpt, and downstream validation only
// checks that a name and price both occur somewhere in the block — it would
// happily "support" the wrong pairing. A neighbouring price line is always a
// hard boundary; a heading line is too, except we allow absorbing exactly
// one heading walking backward, on the assumption that's this offering's own
// name (headings normally precede their price, not follow it).
function candidateWindow(lines: StructuredLine[], index: number): string {
  let start = index;
  let crossedHeading = false;
  for (let cursor = index - 1; cursor >= Math.max(0, index - 2); cursor -= 1) {
    const line = lines[cursor];
    if (!line || priceTokens(line.text).length > 0) break;
    if (line.heading) {
      if (crossedHeading) break;
      crossedHeading = true;
    }
    start = cursor;
  }
  let end = index;
  for (let cursor = index + 1; cursor < Math.min(lines.length, index + 4); cursor += 1) {
    const line = lines[cursor];
    if (!line || priceTokens(line.text).length > 0 || line.heading) break;
    end = cursor;
  }
  return lines.slice(start, end + 1).map(line => line.text).join('\n').slice(0, 2_000).trim();
}

function isUsefulCommercialBlock(block: string, prices: string[]): boolean {
  // Threshold intentionally low: candidateWindow now stops tightly at
  // neighbouring offering boundaries, so a correctly-isolated single-row
  // entry (e.g. "Evening package | £750-£950") is legitimately terse rather
  // than noise.
  if (!prices.length || meaningfulWords(block) < 2) return false;
  if (!COMMERCIAL_HINT_RE.test(block) && !PACKAGE_HINT_RE.test(block)) return false;

  // Deposit/finance values are not publishable package prices on their own.
  // Generic words like "package" or "hire" appear in almost any offering's
  // own name/description regardless of whether a real price is also stated,
  // so they can't be used to exempt a block from this check — require an
  // actual second, distinct price token (a genuine full price stated
  // alongside the deposit) instead.
  if (DEPOSIT_ONLY_RE.test(block) && prices.length < 2) {
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
      const linePrices = priceTokens(lines[index]?.text || '');
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
