import type { DiscoverySearchResult } from '../providers/discovery/provider.js';
import { evaluateDiscoverySearchResult, isKnownNonSupplierDomain } from './discovery-result-quality.service.js';

// Third-party directory / marketplace / listings domains. These are valid
// *data sources* for a supplier with no site of its own (owner decision,
// docs/unclaimed-quality-progress.md), but a profile whose recorded
// "website" is one of them usually points at a listing page that describes
// many businesses -- mining that page for one supplier's phone or photos
// would attach another business's details. This list is therefore used
// only to decide "the recorded website is not the supplier's own site, find
// a better source first"; it never blocks anything.
const DIRECTORY_SOURCE_DOMAINS = [
  'designmynight.com',
  'poptop.uk.com',
  'wedding-caterers.co.uk',
  'event-caterers.co.uk',
  'event-catering.uk',
  'ukweddingservices.com',
  'hirespace.com',
  'wedissimo.com',
  'encoremusicians.com',
  'ewegottalove.com',
  'ticketmaster.co.uk',
  'southwalesguardian.co.uk',
  'celticenglish.co.uk',
  'supplierdirectory.co.uk',
] as const;

const GENERIC_NAME_WORDS = new Set([
  'the', 'and', 'ltd', 'limited', 'llp', 'plc', 'uk', 'of', 'in', 'at', 'for', 'a', 'an',
]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function normalisedParts(url: string): { host: string; path: string } | null {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname.toLowerCase().replace(/^www\./, ''),
      path: parsed.pathname.replace(/\/+$/, '').toLowerCase(),
    };
  } catch {
    return null;
  }
}

// True when `candidate` is the recorded page itself or anything beneath it
// on the same host (scheme, www., trailing slash, query and fragment are all
// ignored) -- a listing's own pagination/filter variants are still the
// listing.
export function isRecordedPageOrChild(recordedUrl: string, candidate: string): boolean {
  const recorded = normalisedParts(recordedUrl);
  const other = normalisedParts(candidate);
  if (!recorded || !other || recorded.host !== other.host) return false;
  return recorded.path === other.path || (recorded.path !== '' && other.path.startsWith(`${recorded.path}/`));
}

// A page is only treated as the business's OWN site when its hostname
// itself contains the business's name; anything else (an unlisted
// directory, a shortener, a parent-company domain) is treated as a
// third-party source with the stricter data rules.
export function hostLooksLikeBusiness(host: string, businessName: string): boolean {
  const label = host.replace(/^www\./, '').split('.')[0]?.replace(/[^a-z0-9]/g, '') ?? '';
  const tokens = significantNameTokens(businessName);
  if (!label || tokens.length === 0) return false;
  return label.includes(tokens.join('')) || tokens.some(token => token.length >= 4 && label.includes(token));
}

export function isDirectorySourceUrl(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return isKnownNonSupplierDomain(host) || DIRECTORY_SOURCE_DOMAINS.some(domain => hostMatches(host, domain));
}

export function significantNameTokens(name: string): string[] {
  return [
    ...new Set(
      name
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(token => token.length >= 2 && !GENERIC_NAME_WORDS.has(token)),
    ),
  ];
}

function coversAllTokens(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
  return tokens.every(token => haystack.includes(` ${token} `));
}

export type SourceKind = 'own_site' | 'directory_profile';

export interface ResolvedSourceCandidate {
  url: string;
  kind: SourceKind;
}

// Chooses, from a name-based web search, the one page most likely to be this
// business's own single-business page. Deliberately strict -- a wrong pick
// would write another business's details onto a live listing:
//   - the result title must name EVERY significant word of the business name
//   - listing/search/roundup/editorial/government results are dropped (same
//     gate discovery uses)
//   - the recorded (listing) URL itself is never re-picked
//   - an own-site (non-directory) result beats a directory profile page
// Returns null when nothing qualifies; the caller then skips rather than
// guesses.
export function pickSourceCandidate(
  businessName: string,
  category: string,
  recordedUrl: string,
  results: DiscoverySearchResult[],
): ResolvedSourceCandidate | null {
  const tokens = significantNameTokens(businessName);
  if (tokens.length === 0) return null;

  const qualified: ResolvedSourceCandidate[] = [];
  for (const result of results) {
    if (isRecordedPageOrChild(recordedUrl, result.url)) continue;
    if (!evaluateDiscoverySearchResult(result, category).eligible) continue;
    if (!coversAllTokens(result.title, tokens)) continue;
    const host = hostOf(result.url);
    if (!host) continue;
    const own = !isDirectorySourceUrl(result.url) && hostLooksLikeBusiness(host, businessName);
    qualified.push({ url: result.url, kind: own ? 'own_site' : 'directory_profile' });
  }
  return qualified.find(item => item.kind === 'own_site') ?? qualified[0] ?? null;
}

// The crawled page itself must independently name the business -- a search
// title alone is not enough. Checks every crawled page's visible text.
export function crawlNamesBusiness(
  businessName: string,
  pageText: Array<{ url: string; text: string }>,
): boolean {
  const tokens = significantNameTokens(businessName);
  return pageText.some(page => coversAllTokens(page.text, tokens));
}

// Keeps only the individual crawled pages that, on their own, name the
// business AND mention its place -- so a directory's other suppliers, its
// footer/support pages, or a sibling brand's page can never contribute
// facts. Returns null when no page qualifies.
export function pagesAboutBusiness<T extends { url: string }>(
  businessName: string,
  location: string | null,
  pages: T[],
  textOf: (page: T) => string,
): T[] {
  const nameTokens = significantNameTokens(businessName);
  const place = location?.split(',')[0]?.trim() ?? '';
  const placeTokens = significantNameTokens(place);
  if (placeTokens.length === 0) return [];
  return pages.filter(page => {
    const text = textOf(page);
    return coversAllTokens(text, nameTokens) && coversAllTokens(text, placeTokens);
  });
}

export function sourceSearchQuery(businessName: string, location: string | null): string {
  return [`"${businessName.replace(/"/g, ' ').trim()}"`, location?.trim()].filter(Boolean).join(' ');
}
