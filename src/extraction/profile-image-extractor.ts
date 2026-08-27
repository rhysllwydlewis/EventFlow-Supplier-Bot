import type { SiteCrawlResult } from '../crawler/site-crawler.js';
import {
  supplierMediaEvidenceSchema,
  type SupplierMediaEvidence,
} from '../domain/supplier-media.js';

const MIN_PROFILE_IMAGE_SCORE = 76;
const LOGO_HINT_RE = /\b(logo|brand|branding|site[-_ ]?identity|wordmark)\b/i;
const NEGATIVE_HINT_RE = /\b(facebook|instagram|youtube|tiktok|tripadvisor|trustpilot|paypal|visa|mastercard|payment|badge|rating|review|favicon|sprite|icon|emoji|placeholder|loading|spinner|tracking|pixel)\b/i;
const NON_IMAGE_EXTENSION_RE = /\.(?:html?|pdf|css|js|json|xml|zip|mp4|webm)(?:$|[?#])/i;
const PREFERRED_LOGO_EXTENSION_RE = /\.(?:svg|png)(?:$|[?#])/i;
const UK_SECOND_LEVEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk']);

type CandidateSource = 'structured' | 'header' | 'brand_hint';

interface CandidateInput {
  rawUrl: string;
  pageUrl: string;
  source: CandidateSource;
  identityNames: string[];
  alt?: string | null;
  width?: number | null;
  height?: number | null;
  hint?: string;
}

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

function resolveImageUrl(raw: string, pageUrl: string): URL | null {
  const value = raw.trim();
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

function normalizeIdentity(value: string): string {
  return value.toLowerCase().replace(/&amp;/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
}

function identityMatches(value: string, identityNames: string[]): boolean {
  const normalized = normalizeIdentity(value);
  if (!normalized) return false;
  return identityNames.some(name => {
    const wanted = normalizeIdentity(name);
    if (wanted.length < 4) return false;
    return normalized.includes(wanted) || wanted.includes(normalized);
  });
}

function jsonLdValues(html: string): unknown[] {
  const values: unknown[] = [];
  const scriptRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) && values.length < 30) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      values.push(JSON.parse(raw) as unknown);
    } catch {
      // Malformed JSON-LD is common and must not fail discovery.
    }
  }
  return values;
}

function pageIdentityNames(html: string): string[] {
  const names: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = htmlAttributes(tag);
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key === 'og:site_name' && attrs.content) names.push(attrs.content);
  }

  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (title) {
    for (const part of title.split(/[|–—]/).map(value => value.trim())) {
      if (part.length >= 3 && part.length <= 100) names.push(part);
    }
  }

  function visit(value: unknown): void {
    if (value === null || value === undefined || names.length >= 30) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (object.logo && typeof object.name === 'string') names.push(object.name);
    for (const child of Object.values(object)) visit(child);
  }
  jsonLdValues(html).forEach(visit);

  const normalizedSeen = new Set<string>();
  return names.filter(name => {
    const normalized = normalizeIdentity(name);
    if (normalized.length < 3 || normalizedSeen.has(normalized)) return false;
    normalizedSeen.add(normalized);
    return true;
  }).slice(0, 20);
}

function candidateTexts(input: CandidateInput, imageUrl: URL): {
  signalText: string;
  filenameText: string;
} {
  const signalText = [input.alt, input.hint]
    .filter(Boolean)
    .join(' ')
    .replace(/[-_]+/g, ' ')
    .slice(0, 1_000);
  const filenameText = imageUrl.pathname.replace(/[-_]+/g, ' ').slice(-500);
  return { signalText, filenameText };
}

function buildCandidate(input: CandidateInput): SupplierMediaEvidence | null {
  const imageUrl = resolveImageUrl(input.rawUrl, input.pageUrl);
  if (!imageUrl || NON_IMAGE_EXTENSION_RE.test(imageUrl.href)) return null;
  const pageUrl = new URL(input.pageUrl);
  const { signalText, filenameText } = candidateTexts(input, imageUrl);
  const combinedHint = `${signalText} ${filenameText}`;

  if (NEGATIVE_HINT_RE.test(combinedHint)) return null;

  const explicitBrandHint = LOGO_HINT_RE.test(signalText);
  const filenameBrandHint = LOGO_HINT_RE.test(filenameText);
  const nameSignalMatch = identityMatches(signalText, input.identityNames);
  const nameFilenameMatch = identityMatches(filenameText, input.identityNames);

  // Header/nav location is a useful signal, but it is not enough by itself:
  // promotional photos and decorative artwork also commonly live in headers.
  if (
    input.source === 'header' &&
    !explicitBrandHint &&
    !filenameBrandHint &&
    !nameSignalMatch &&
    !nameFilenameMatch
  ) {
    return null;
  }

  // Outside a header/nav, do not accept a file merely because its filename
  // contains "logo". Real sites often use decorative assets such as
  // "logoshape.svg" that are not the business's profile mark.
  if (input.source === 'brand_hint' && !explicitBrandHint && !nameSignalMatch) {
    return null;
  }

  const width = input.width ?? null;
  const height = input.height ?? null;
  if (width !== null && height !== null) {
    if (width < 40 || height < 20 || width * height < 1_200) return null;
    const ratio = Math.max(width / height, height / width);
    if (ratio > 10) return null;
  }

  const same = sameSite(imageUrl, pageUrl);
  let score = input.source === 'structured' ? 92 : input.source === 'header' ? 45 : 42;
  if (explicitBrandHint) score += 28;
  if (filenameBrandHint) score += 20;
  if (nameSignalMatch) score += 24;
  if (nameFilenameMatch) score += 10;
  if (same) score += 6;
  if (PREFERRED_LOGO_EXTENSION_RE.test(imageUrl.href)) score += 4;
  if (width !== null && height !== null) {
    const ratio = width / height;
    if (ratio >= 0.5 && ratio <= 4.5) score += 4;
  }
  score = Math.min(100, score);
  if (score < MIN_PROFILE_IMAGE_SCORE) return null;

  const sourceLabel = input.source === 'structured'
    ? 'structured data'
    : input.source === 'header'
      ? 'site header'
      : 'site branding';
  const rawAlt = input.alt?.trim().slice(0, 220) || '';
  const classifiedAlt = `Official business logo (${sourceLabel})${rawAlt ? ` — ${rawAlt}` : ''}`.slice(0, 300);

  return supplierMediaEvidenceSchema.parse({
    url: imageUrl.href,
    sourcePageUrl: pageUrl.href,
    kind: 'inline_image',
    alt: classifiedAlt,
    width,
    height,
    score,
    sameSite: same,
  });
}

function jsonLdLogoUrls(html: string): string[] {
  const urls: string[] = [];

  function visit(value: unknown): void {
    if (urls.length >= 20 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase() === 'logo') {
        if (typeof child === 'string') urls.push(child);
        else if (child && typeof child === 'object') {
          const object = child as Record<string, unknown>;
          const url = object.url ?? object.contentUrl;
          if (typeof url === 'string') urls.push(url);
        }
      }
      visit(child);
    }
  }

  jsonLdValues(html).forEach(visit);
  return [...new Set(urls)].slice(0, 20);
}

function imageTags(fragment: string): string[] {
  return fragment.match(/<img\b[^>]*>/gi) ?? [];
}

function headerFragments(html: string): string[] {
  return [
    ...(html.match(/<header\b[^>]*>[\s\S]*?<\/header>/gi) ?? []),
    ...(html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi) ?? []),
  ];
}

function candidateFromImg(
  tag: string,
  pageUrl: string,
  source: CandidateSource,
  identityNames: string[],
): SupplierMediaEvidence | null {
  const attrs = htmlAttributes(tag);
  const rawUrl =
    bestSrcsetValue(attrs.srcset) ||
    bestSrcsetValue(attrs['data-srcset']) ||
    attrs.src ||
    attrs['data-src'] ||
    attrs['data-lazy-src'] ||
    attrs['data-original'];
  if (!rawUrl) return null;
  const hint = [attrs.class, attrs.id, attrs.role, attrs['aria-label'], attrs.title]
    .filter(Boolean)
    .join(' ');
  return buildCandidate({
    rawUrl,
    pageUrl,
    source,
    identityNames,
    alt: attrs.alt || attrs.title || null,
    width: parsePositiveInt(attrs.width),
    height: parsePositiveInt(attrs.height),
    hint,
  });
}

function headerBackgroundCandidates(
  fragment: string,
  pageUrl: string,
  identityNames: string[],
): SupplierMediaEvidence[] {
  const output: SupplierMediaEvidence[] = [];
  for (const tag of fragment.match(/<[a-z][^>]*\bstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi) ?? []) {
    const attrs = htmlAttributes(tag);
    const hint = [attrs.class, attrs.id, attrs.role, attrs['aria-label'], attrs.title]
      .filter(Boolean)
      .join(' ');
    for (const rawUrl of inlineStyleImages(attrs.style)) {
      const candidate = buildCandidate({
        rawUrl,
        pageUrl,
        source: 'header',
        identityNames,
        alt: attrs['aria-label'] || attrs.title || null,
        width: parsePositiveInt(attrs.width),
        height: parsePositiveInt(attrs.height),
        hint,
      });
      if (candidate) output.push(candidate);
    }
  }
  return output;
}

export function extractSupplierProfileImage(crawl: SiteCrawlResult): SupplierMediaEvidence | null {
  const candidates = new Map<string, { candidate: SupplierMediaEvidence; pages: Set<string> }>();

  function add(candidate: SupplierMediaEvidence | null): void {
    if (!candidate) return;
    const existing = candidates.get(candidate.url);
    if (!existing) {
      candidates.set(candidate.url, { candidate, pages: new Set([candidate.sourcePageUrl]) });
      return;
    }
    existing.pages.add(candidate.sourcePageUrl);
    if (candidate.score > existing.candidate.score) existing.candidate = candidate;
  }

  for (const page of crawl.pages) {
    const identityNames = pageIdentityNames(page.html);
    for (const rawUrl of jsonLdLogoUrls(page.html)) {
      add(buildCandidate({
        rawUrl,
        pageUrl: page.url,
        source: 'structured',
        identityNames,
        alt: null,
        hint: 'logo',
      }));
    }

    for (const fragment of headerFragments(page.html)) {
      for (const tag of imageTags(fragment)) {
        add(candidateFromImg(tag, page.url, 'header', identityNames));
      }
      for (const candidate of headerBackgroundCandidates(fragment, page.url, identityNames)) {
        add(candidate);
      }
    }

    for (const tag of imageTags(page.html)) {
      add(candidateFromImg(tag, page.url, 'brand_hint', identityNames));
    }
  }

  return [...candidates.values()]
    .map(({ candidate, pages }) => ({
      ...candidate,
      score: Math.min(100, candidate.score + (pages.size > 1 ? Math.min(8, (pages.size - 1) * 3) : 0)),
    }))
    .sort((a, b) => b.score - a.score || Number(b.sameSite) - Number(a.sameSite) || a.url.localeCompare(b.url))[0] ?? null;
}
