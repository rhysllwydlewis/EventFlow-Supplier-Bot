import type { Campaign } from '../domain/campaign.js';

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
    const terms = CATEGORY_QUERY_TERMS[category] ?? [category.toLowerCase()];
    for (const location of campaign.locations) {
      for (const term of terms) {
        queries.push({
          campaignId: campaign.id,
          category,
          location,
          query: `${term} ${location}`.trim(),
        });
      }
    }
  }
  return queries;
}
