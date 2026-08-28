import type { SiteCrawlResult } from '../crawler/site-crawler.js';
import type { SupplierMediaEvidence } from '../domain/supplier-media.js';
import { extractSupplierMedia } from './image-extractor.js';
import { extractSupplierProfileImage } from './profile-image-extractor.js';

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UK_PHONE_RE = /(?:\+44\s?\d{2,4}|0\d{2,4})[\s().-]*\d{3,4}[\s.-]*\d{3,4}\b/g;
const PRICE_RE = /(?:from\s+|starting\s+(?:at|from)\s+)?£\s?\d[\d,]*(?:\.\d{1,2})?/gi;
const JSON_LD_RE = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
// A mailto:/tel: link is a deliberate "this is our contact info" signal from
// the page author -- a plain-text regex match anywhere on the site (an
// author bio, a stray testimonial email, a phone number quoted in a blog
// post) carries no such signal and can belong to someone other than the
// business. These are checked first so that ownership-flagged contact
// details are preferred over an unattributed text match when one exists.
const MAILTO_HREF_RE = /href\s*=\s*["']mailto:([^"'?]+)/gi;
const TEL_HREF_RE = /href\s*=\s*["']tel:([^"']+)/gi;

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

// Orders `matches` so any value also present in `attributed` (extracted
// from a mailto:/tel: href, not free text) sorts first, without dropping
// the rest -- every match found is still returned, just with the
// ownership-signalled ones preferred for whichever consumer only wants a
// single "best" value (Array[0]).
function preferAttributed(matches: string[], attributed: Set<string>): string[] {
  return [...matches].sort((a, b) => Number(attributed.has(b)) - Number(attributed.has(a)));
}

function decodeHrefValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding in a hand-written href shouldn't fail the
    // whole crawl -- fall back to the raw (still usable) attribute value.
    return value;
  }
}

function extractMailtoEmails(html: string): string[] {
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = MAILTO_HREF_RE.exec(html))) {
    const value = match[1]?.trim();
    if (value) values.push(decodeHrefValue(value));
  }
  return values;
}

function extractTelPhones(html: string): string[] {
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = TEL_HREF_RE.exec(html))) {
    const value = match[1]?.trim();
    if (value) values.push(decodeHrefValue(value));
  }
  return values;
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
  profileImageCandidate?: SupplierMediaEvidence | null;
}

export function extractBasicFacts(crawl: SiteCrawlResult): BasicExtraction {
  const emails: string[] = [];
  const phones: string[] = [];
  const prices: string[] = [];
  const jsonLd: unknown[] = [];
  const pageText: Array<{ url: string; text: string }> = [];
  const attributedEmails = new Set<string>();
  const attributedPhones = new Set<string>();

  for (const page of crawl.pages) {
    const text = stripTags(page.html).slice(0, 100_000);
    pageText.push({ url: page.url, text });
    emails.push(...(page.html.match(EMAIL_RE) ?? []));
    phones.push(...(text.match(UK_PHONE_RE) ?? []));
    prices.push(...(text.match(PRICE_RE) ?? []));
    jsonLd.push(...extractJsonLd(page.html));

    // A tel: href in particular can carry a number that never appears in
    // the page's *visible* text at all (e.g. a "Call us" link), so these
    // are added to the pool, not just used to reorder it.
    for (const value of extractMailtoEmails(page.html)) {
      attributedEmails.add(value.toLowerCase());
      emails.push(value);
    }
    for (const value of extractTelPhones(page.html)) {
      attributedPhones.add(value);
      phones.push(value);
    }
  }

  return {
    emails: preferAttributed(unique(emails.map(value => value.toLowerCase()), 20), attributedEmails),
    phones: preferAttributed(unique(phones, 20), attributedPhones),
    advertisedPrices: unique(prices, 50),
    jsonLd: jsonLd.slice(0, 100),
    pageText,
    media: extractSupplierMedia(crawl),
    profileImageCandidate: extractSupplierProfileImage(crawl),
  };
}
