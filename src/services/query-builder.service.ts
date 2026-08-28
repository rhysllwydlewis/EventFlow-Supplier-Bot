import type { Campaign } from '../domain/campaign.js';
import { logger } from '../lib/logger.js';

// Category/location are free text an operator types into the Control
// dashboard, then dropped straight into a search provider's query string --
// no injection risk (admin-only, URL-encoded downstream), but a stray
// search operator (site:, inurl:, filetype:, ...) would silently produce an
// unintended query with no feedback that anything was off. A colon-prefixed
// "word:" is never a legitimate place or category name, so stripping that
// specific pattern can't false-positive on a real one.
const SEARCH_OPERATOR_RE = /\b\w+:\S*/g;
function sanitizeSearchTerm(value: string, field: 'category' | 'location', campaignId: string): string {
  const stripped = value.replace(SEARCH_OPERATOR_RE, ' ').replace(/\s+/g, ' ').trim();
  if (stripped !== value.trim()) {
    logger.warn(
      { campaignId, field, original: value, sanitized: stripped },
      'Stripped a search-operator-like pattern from a campaign field before building a discovery query',
    );
  }
  return stripped;
}

const CATEGORY_QUERY_TERMS: Record<string, string[]> = {
  Venues: ['wedding venues', 'event venues'],
  Photography: ['wedding photographers', 'event photographers'],
  Videography: ['wedding videographers', 'event videographers'],
  Catering: ['wedding caterers', 'event catering'],
  Florist: ['wedding florists', 'event florists'],
  'Music/DJ': ['wedding DJs', 'event DJs'],
};

export interface DiscoveryQuery {
  campaignId: string;
  category: string;
  location: string;
  query: string;
}

export function buildDiscoveryQueries(campaign: Campaign): DiscoveryQuery[] {
  const queries: DiscoveryQuery[] = [];
  for (const category of campaign.categories) {
    // Only the fallback term (an unrecognized category, typed by an
    // operator) is free text -- a known category's terms above are a fixed
    // lookup, never user input, so nothing to sanitize there.
    const terms = CATEGORY_QUERY_TERMS[category]
      ?? [sanitizeSearchTerm(category.toLowerCase(), 'category', campaign.id)];
    for (const location of campaign.locations) {
      const sanitizedLocation = sanitizeSearchTerm(location, 'location', campaign.id);
      for (const term of terms) {
        queries.push({
          campaignId: campaign.id,
          category,
          location,
          query: `${term} ${sanitizedLocation}`.trim(),
        });
      }
    }
  }
  return queries;
}
