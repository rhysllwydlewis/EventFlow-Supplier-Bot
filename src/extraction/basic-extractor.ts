import type { SiteCrawlResult } from '../crawler/site-crawler.js';
import type { SupplierMediaEvidence } from '../domain/supplier-media.js';
import { extractSupplierMedia } from './image-extractor.js';

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UK_PHONE_RE = /(?:\+44\s?\d{2,4}|0\d{2,4})[\s().-]*\d{3,4}[\s.-]*\d{3,4}\b/g;
const PRICE_RE = /(?:from\s+|starting\s+(?:at|from)\s+)?£\s?\d[\d,]*(?:\.\d{1,2})?/gi;
const JSON_LD_RE = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function stripTags(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(values: string[], max = 50): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, max);
}

function extractJsonLd(html: string): unknown[] {
  const values: unknown[] = [];
  let match: RegExpExecArray | null;
  while ((match = JSON_LD_RE.exec(html)) && values.length < 20) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) values.push(...parsed);
      else values.push(parsed);
    } catch {
      // Invalid JSON-LD is common enough that it should not fail the crawl.
    }
  }
  return values.slice(0, 50);
}

export interface BasicExtraction {
  emails: string[];
  phones: string[];
  advertisedPrices: string[];
  jsonLd: unknown[];
  pageText: Array<{ url: string; text: string }>;
  media: SupplierMediaEvidence[];
}

export function extractBasicFacts(crawl: SiteCrawlResult): BasicExtraction {
  const emails: string[] = [];
  const phones: string[] = [];
  const prices: string[] = [];
  const jsonLd: unknown[] = [];
  const pageText: Array<{ url: string; text: string }> = [];

  for (const page of crawl.pages) {
    const text = stripTags(page.html).slice(0, 100_000);
    pageText.push({ url: page.url, text });
    emails.push(...(page.html.match(EMAIL_RE) ?? []));
    phones.push(...(text.match(UK_PHONE_RE) ?? []));
    prices.push(...(text.match(PRICE_RE) ?? []));
    jsonLd.push(...extractJsonLd(page.html));
  }

  return {
    emails: unique(emails.map(value => value.toLowerCase()), 20),
    phones: unique(phones, 20),
    advertisedPrices: unique(prices, 50),
    jsonLd: jsonLd.slice(0, 100),
    pageText,
    media: extractSupplierMedia(crawl),
  };
}
