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
    if (result.url === recordedUrl) continue;
    if (!evaluateDiscoverySearchResult(result, category).eligible) continue;
    if (!coversAllTokens(result.title, tokens)) continue;
    if (!hostOf(result.url)) continue;
    qualified.push({ url: result.url, kind: isDirectorySourceUrl(result.url) ? 'directory_profile' : 'own_site' });
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

// Guards against a same-named business in another town: the crawled pages
// must also mention the profile's own place (its first comma-separated part,
// e.g. "Cardiff" from "Cardiff, Wales"). A profile with no recorded location
// has nothing to check against.
export function crawlMentionsLocation(
  location: string | null,
  pageText: Array<{ url: string; text: string }>,
): boolean {
  const place = location?.split(',')[0]?.trim();
  if (!place) return true;
  const tokens = significantNameTokens(place);
  return pageText.some(page => coversAllTokens(page.text, tokens));
}

export function sourceSearchQuery(businessName: string, location: string | null): string {
  return [`"${businessName.replace(/"/g, ' ').trim()}"`, location?.trim()].filter(Boolean).join(' ');
}
