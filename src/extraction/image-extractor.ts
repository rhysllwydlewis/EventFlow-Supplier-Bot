import type { SiteCrawlResult } from '../crawler/site-crawler.js';
import {
  supplierMediaEvidenceSchema,
  type SupplierMediaEvidence,
} from '../domain/supplier-media.js';

const MAX_MEDIA_EVIDENCE = 20;
const MIN_ACCEPTED_SCORE = 45;
const UK_SECOND_LEVEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk']);
const PHOTO_HINT_RE = /\b(wedding|venue|ceremony|reception|ballroom|barn|castle|manor|estate|vineyard|hotel|hall|interior|exterior|garden|grounds|suite|room|event|celebration)\b/i;
const NEGATIVE_HINT_RE = /\b(logo|icon|favicon|avatar|sprite|badge|payment|paypal|visa|mastercard|facebook|instagram|youtube|tiktok|tripadvisor|trustpilot|emoji|placeholder|loading|spinner|pixel|tracking|map|pin|arrow|chevron)\b/i;
const NON_PHOTO_EXTENSION_RE = /\.(?:svg|ico|gif)(?:$|[?#])/i;
const IMAGE_LIKE_EXTENSION_RE = /\.(?:jpe?g|png|webp|avif)(?:$|[?#])/i;

function htmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = tag.replace(/^<\/?[a-z0-9:-]+\b/i, '').replace(/\/?\s*>$/, '');
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const key = (match[1] || '').toLowerCase();
    if (!key) continue;
    attrs[key] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 20_000 ? parsed : null;
}

function siteKey(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/^www\./, '');
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length <= 2) return normalized;
  const lastTwo = parts.slice(-2).join('.');
  if (UK_SECOND_LEVEL_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

function sameSite(a: URL, b: URL): boolean {
  return siteKey(a.hostname) === siteKey(b.hostname);
}

function resolveImageUrl(raw: string | undefined, pageUrl: string): URL | null {
  const value = raw?.trim();
  if (!value || value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('javascript:')) {
    return null;
  }
  try {
    const url = new URL(value, pageUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    if (url.href.length > 2_048) return null;
    return url;
  } catch {
    return null;
  }
}

function bestSrcsetValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidates = value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const [url, descriptor = ''] = part.split(/\s+/, 2);
      const width = descriptor.endsWith('w') ? Number.parseInt(descriptor.slice(0, -1), 10) : 0;
      const density = descriptor.endsWith('x') ? Number.parseFloat(descriptor.slice(0, -1)) * 1_000 : 0;
      return { url, score: Number.isFinite(width) ? width : Number.isFinite(density) ? density : 0 };
    })
    .filter(item => Boolean(item.url));
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.url;
}

function inlineStyleImages(style: string | undefined): string[] {
  if (!style) return [];
  const urls: string[] = [];
  const pattern = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(style)) && urls.length < 4) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) urls.push(value);
  }
  return urls;
}

function textualHint(...values: Array<string | null | undefined>): string {
  return values.filter(Boolean).join(' ').replace(/[-_]+/g, ' ').slice(0, 1_000);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function imageFilename(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  return safeDecodeURIComponent(last).replace(/[-_]+/g, ' ');
}

function scoreCandidate(input: {
  kind: SupplierMediaEvidence['kind'];
  imageUrl: URL;
  pageUrl: URL;
  alt: string | null;
  width: number | null;
  height: number | null;
}): { score: number; sameSite: boolean } | null {
  const same = sameSite(input.imageUrl, input.pageUrl);
  const hint = textualHint(input.alt, imageFilename(input.imageUrl), input.pageUrl.pathname);

  if (NON_PHOTO_EXTENSION_RE.test(input.imageUrl.href)) return null;
  if (NEGATIVE_HINT_RE.test(hint)) return null;
  if (input.width !== null && input.height !== null) {
    if (input.width < 320 || input.height < 180) return null;
    if (input.width * input.height < 160_000) return null;
  }

  if (!same && input.kind !== 'open_graph') return null;

  let score = input.kind === 'open_graph' ? 82 : input.kind === 'picture_source' ? 58 : 52;
  if (same) score += 8;
  if (PHOTO_HINT_RE.test(hint)) score += 12;
  if (IMAGE_LIKE_EXTENSION_RE.test(input.imageUrl.href)) score += 4;
  if (input.width !== null && input.height !== null) {
    if (input.width >= 1_200 && input.height >= 600) score += 8;
    else if (input.width >= 800 && input.height >= 450) score += 5;
  }
  if (/\b(gallery|wedding|venue|events?)\b/i.test(input.pageUrl.pathname.replace(/[/_-]+/g, ' '))) {
    score += 5;
  }
  return { score: Math.min(100, score), sameSite: same };
}

function pushCandidate(
  output: SupplierMediaEvidence[],
  input: {
    rawUrl: string | undefined;
    pageUrl: string;
    kind: SupplierMediaEvidence['kind'];
    alt?: string | null;
    width?: number | null;
    height?: number | null;
  },
): void {
  const imageUrl = resolveImageUrl(input.rawUrl, input.pageUrl);
  if (!imageUrl) return;
  const pageUrl = new URL(input.pageUrl);
  const scored = scoreCandidate({
    kind: input.kind,
    imageUrl,
    pageUrl,
    alt: input.alt ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
  });
  if (!scored || scored.score < MIN_ACCEPTED_SCORE) return;

  const candidate = supplierMediaEvidenceSchema.parse({
    url: imageUrl.href,
    sourcePageUrl: pageUrl.href,
    kind: input.kind,
    alt: input.alt?.trim().slice(0, 300) || null,
    width: input.width ?? null,
    height: input.height ?? null,
    score: scored.score,
    sameSite: scored.sameSite,
  });
  output.push(candidate);
}

function extractPageImages(pageUrl: string, html: string): SupplierMediaEvidence[] {
  const output: SupplierMediaEvidence[] = [];

  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = htmlAttributes(tag);
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (!['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'].includes(key)) continue;
    pushCandidate(output, { rawUrl: attrs.content, pageUrl, kind: 'open_graph', alt: null });
  }

  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const attrs = htmlAttributes(tag);
    const rawUrl =
      bestSrcsetValue(attrs.srcset) ||
      bestSrcsetValue(attrs['data-srcset']) ||
      attrs.src ||
      attrs['data-src'] ||
      attrs['data-lazy-src'] ||
      attrs['data-original'];
    const width = parsePositiveInt(attrs.width);
    const height = parsePositiveInt(attrs.height);
    pushCandidate(output, {
      rawUrl,
      pageUrl,
      kind: 'inline_image',
      alt: attrs.alt || attrs.title || null,
      width,
      height,
    });
  }

  for (const tag of html.match(/<source\b[^>]*>/gi) ?? []) {
    const attrs = htmlAttributes(tag);
    const rawUrl = bestSrcsetValue(attrs.srcset) || bestSrcsetValue(attrs['data-srcset']);
    pushCandidate(output, {
      rawUrl,
      pageUrl,
      kind: 'picture_source',
      alt: null,
      width: null,
      height: null,
    });
  }

  // Hero/gallery imagery is commonly assigned to div/section containers rather
  // than img elements. Inspect any inline style attribute without loading CSS or
  // remote image bytes; same-site filtering still applies in scoreCandidate.
  for (const tag of html.match(/<[a-z][^>]*\bstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi) ?? []) {
    const attrs = htmlAttributes(tag);
    for (const backgroundUrl of inlineStyleImages(attrs.style)) {
      pushCandidate(output, {
        rawUrl: backgroundUrl,
        pageUrl,
        kind: 'background_image',
        alt: attrs['aria-label'] || attrs.title || null,
        width: parsePositiveInt(attrs.width),
        height: parsePositiveInt(attrs.height),
      });
    }
  }

  return output;
}

export function extractSupplierMedia(crawl: SiteCrawlResult): SupplierMediaEvidence[] {
  const byUrl = new Map<string, SupplierMediaEvidence>();
  for (const page of crawl.pages) {
    for (const candidate of extractPageImages(page.url, page.html)) {
      const existing = byUrl.get(candidate.url);
      if (!existing || candidate.score > existing.score) {
        byUrl.set(candidate.url, candidate);
      }
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, MAX_MEDIA_EVIDENCE);
}
