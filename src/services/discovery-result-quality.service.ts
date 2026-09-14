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
  // Regional tourism-board / venue-directory sites: a page here describes
  // (or lists search results for) many venues run by other businesses, not
  // a supplier of its own. Confirmed live in production -- both slipped
  // past every other check here and were published with the directory's
  // own URL recorded as the individual business's "website", a wrong and
  // misleading link for a real business (britainsfinest.co.uk/.../search/
  // for "Appleby Castle"; meetnorthwales.co.uk/venues/ for "Anglo Welsh").
  'britainsfinest.co.uk',
  'meetnorthwales.co.uk',
  'meetcardiff.com',
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

// Domain-only version of the discovery-time block list, reused as a
// defense-in-depth check at publication time (eventflow-publication.service.ts).
// Discovery is the front door for how a candidate enters the pipeline, but it
// is not the only door: a candidate can also predate this filter (or a future
// gap in it), so publication itself must independently refuse to ever list a
// known directory/editorial/government/UGC domain as if it were a supplier,
// regardless of how it got into the candidates collection.
export function isKnownNonSupplierDomain(domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  return (
    BLOCKED_DISCOVERY_DOMAINS.some(blocked => domainMatches(normalized, blocked))
    || isGovernmentDomain(normalized)
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
  // Not editorial content, but the same underlying problem: a page whose
  // URL path is a directory's own search/finder mechanism lists results
  // for many other businesses -- it is never itself a single supplier's
  // page, even when it plausibly ranks for a category+location query and
  // its content names a specific real business. Confirmed live in
  // production ("Appleby Castle" published with a britainsfinest.co.uk
  // /weddingvenues/search/in/northwales URL recorded as its own website).
  'search',
  'venue-finder',
  'find-a-venue',
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
  // Get Married"), so match the phrase they actually use instead -- but
  // require a leading number so a genuine single-venue title using the same
  // wording ("The Perfect Place to Get Married in Wales") isn't rejected.
  /\b\d+\s+(?:\w+\s+){0,3}places?\s+to\s+get\s+married\b/i,
] as const;

const VENUE_TERMS = /\b(venue|venues|hotel|manor|castle|barn|estate|vineyard|country house|house|hall|resort|spa|farm)\b/i;
// Broader than VENUE_TERMS: a genuine venue's own description talks about
// hosting/hiring space even when it never uses one of the specific building
// words above (e.g. a park pavilion, a boathouse, a marquee field).
const EVENT_HOSTING_TERMS = /\b(host(?:s|ing)?|hire|hired|hiring|wedding|conference|ceremony|reception|function room|event space|meeting room|private event)\b/i;
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

// Reuses the same venue vocabulary as the discovery-time categoryMismatch
// check above, but against a shadow profile's own extracted description and
// services -- much richer text than a search snippet, and available at
// compliance time regardless of how the candidate entered the pipeline.
// Confirmed live in production: a canal-boat cruise operator was published
// as category "Venues" (inherited from whichever campaign search query
// happened to surface it, never checked against what the business actually
// turned out to be). NON_VENUE_SUPPLIER_TERMS is checked first and
// independently of the venue/event-hosting absence check below it: a
// wedding photographer's own AI-written description legitimately says
// "wedding" throughout (also confirmed live -- "Babs Boardwell Photography
// provides elopement and small wedding photography..."), which would pass
// the absence check on EVENT_HOSTING_TERMS alone and stay unflagged.
export function isVenueCategoryContentMismatch(category: string, text: string): boolean {
  if (category.trim().toLowerCase() !== 'venues') return false;
  if (NON_VENUE_SUPPLIER_TERMS.test(text)) return true;
  return !VENUE_TERMS.test(text) && !EVENT_HOSTING_TERMS.test(text);
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
