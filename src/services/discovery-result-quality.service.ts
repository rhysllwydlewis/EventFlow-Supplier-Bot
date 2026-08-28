import type { DiscoverySearchResult } from '../providers/discovery/provider.js';

export type DiscoveryResultRejectionReason =
  | 'directory_or_editorial_domain'
  | 'government_domain'
  | 'editorial_result'
  | 'category_mismatch'
  | 'invalid_url';

export interface DiscoveryResultQualityDecision {
  eligible: boolean;
  domain?: string;
  reason?: DiscoveryResultRejectionReason;
}

const BLOCKED_DISCOVERY_DOMAINS = [
  'hitched.co.uk',
  'bridebook.com',
  // Bridebook trades from the .co.uk TLD for its actual UK product; the .com
  // entry above never matched their real domain.
  'bridebook.co.uk',
  'visitwales.com',
  'goodhotelguide.com',
  'tripadvisor.co.uk',
  'tripadvisor.com',
  'guidesforbrides.co.uk',
  'weddingwire.co.uk',
  'weddingwire.com',
  'tagvenue.com',
  'venuescanner.com',
  'eventbrite.co.uk',
  'eventbrite.com',
  'yell.com',
  'yelp.co.uk',
  'yelp.com',
  'facebook.com',
  'instagram.com',
  'pinterest.com',
  'youtube.com',
  'tiktok.com',
  // Forums/UGC platforms: a thread about venues is not a venue's own page.
  'reddit.com',
  'quora.com',
  'mumsnet.com',
] as const;

// Government and public-body domains are never a commercial wedding supplier,
// regardless of what a search result's title claims (e.g. Cadw, the Welsh
// Government's historic environment service, publishes visitor pages for
// castles that also host weddings, but Cadw itself is not the supplier).
const GOVERNMENT_DOMAIN_SUFFIXES = ['.gov.uk', '.gov.wales'] as const;

function isGovernmentDomain(domain: string): boolean {
  return GOVERNMENT_DOMAIN_SUFFIXES.some(
    suffix => domain === suffix.slice(1) || domain.endsWith(suffix),
  );
}

const EDITORIAL_PATH_SEGMENTS = new Set([
  'blog',
  'blogs',
  'news',
  'article',
  'articles',
  'guide',
  'guides',
  'inspiration',
  'ideas',
  'tips',
  'journal',
]);

const EDITORIAL_TITLE_PATTERNS = [
  /\bmy\s+top\s+\d+\b/i,
  /\btop\s+\d+\s+.*\bvenues?\b/i,
  /\b\d+\s+(?:best|top)\s+.*\bvenues?\b/i,
  /\b\d+\s+of\s+the\s+best\b/i,
  /\bcompare\s+prices?\b/i,
  /\bprices?\s*(?:&|and)\s*reviews?\b/i,
  /^(?:affordable|best|cheap|luxury|unique|historic)\b.*\bvenues?\b.*\b(?:in|near)\b/i,
  // Roundups often skip the word "venue" entirely ("16 of the Best Places to
  // Get Married"), so match the phrase they actually use instead.
  /\bplaces?\s+to\s+get\s+married\b/i,
] as const;

const VENUE_TERMS = /\b(venue|venues|hotel|manor|castle|barn|estate|vineyard|country house|house|hall|resort|spa|farm)\b/i;
const NON_VENUE_SUPPLIER_TERMS = /\b(photograph(?:er|ers|y|ic)?|videograph(?:er|ers|y|ic)?|florist|flowers?|caterer|catering|photo booth|wedding dj|mobile dj)\b/i;

function domainMatches(domain: string, blocked: string): boolean {
  return domain === blocked || domain.endsWith(`.${blocked}`);
}

function hasEditorialPath(url: URL): boolean {
  return url.pathname
    .split('/')
    .map(segment => segment.trim().toLowerCase())
    .filter(Boolean)
    .some(segment => EDITORIAL_PATH_SEGMENTS.has(segment));
}

function isEditorialTitle(title: string): boolean {
  return EDITORIAL_TITLE_PATTERNS.some(pattern => pattern.test(title.trim()));
}

function categoryMismatch(item: DiscoverySearchResult, category: string): boolean {
  if (category.trim().toLowerCase() !== 'venues') return false;
  const text = `${item.title} ${item.snippet ?? ''}`;
  return NON_VENUE_SUPPLIER_TERMS.test(text) && !VENUE_TERMS.test(text);
}

export function evaluateDiscoverySearchResult(
  item: DiscoverySearchResult,
  category: string,
): DiscoveryResultQualityDecision {
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    return { eligible: false, reason: 'invalid_url' };
  }

  const domain = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!domain) return { eligible: false, reason: 'invalid_url' };

  if (BLOCKED_DISCOVERY_DOMAINS.some(blocked => domainMatches(domain, blocked))) {
    return { eligible: false, domain, reason: 'directory_or_editorial_domain' };
  }

  if (isGovernmentDomain(domain)) {
    return { eligible: false, domain, reason: 'government_domain' };
  }

  if (hasEditorialPath(url) || isEditorialTitle(item.title)) {
    return { eligible: false, domain, reason: 'editorial_result' };
  }

  if (categoryMismatch(item, category)) {
    return { eligible: false, domain, reason: 'category_mismatch' };
  }

  return { eligible: true, domain };
}
