import { describe, expect, it } from 'vitest';
import { southWalesVenuePilot } from '../src/domain/campaign.js';
import { buildDiscoveryQueries } from '../src/services/query-builder.service.js';

describe('discovery query builder', () => {
  it('builds deterministic venue searches for the pilot', () => {
    const queries = buildDiscoveryQueries(southWalesVenuePilot());
    expect(queries.map(item => item.query)).toEqual([
      'wedding venues South Wales',
      'event venues South Wales',
    ]);
  });

  it('strips a stray search-operator pattern from a free-text location before building the query', () => {
    // A colon-prefixed "word:" (site:, inurl:, filetype:, ...) is never a
    // legitimate place name -- an operator typing one into a campaign field
    // would otherwise silently produce an unintended provider query.
    const campaign = { ...southWalesVenuePilot(), locations: ['site:example.com Cardiff'] };
    const queries = buildDiscoveryQueries(campaign);
    expect(queries.map(item => item.query)).toEqual([
      'wedding venues Cardiff',
      'event venues Cardiff',
    ]);
    // The original value is preserved on the returned query for accurate
    // labelling/audit trail (locationHint on the created candidate) --
    // only what's concatenated into the actual search string is sanitized.
    expect(queries[0]?.location).toBe('site:example.com Cardiff');
  });

  it('sanitizes a free-text category term used as a fallback for an unrecognized category', () => {
    const campaign = {
      ...southWalesVenuePilot(),
      categories: ['inurl:admin Marquee Hire'],
    };
    const queries = buildDiscoveryQueries(campaign);
    expect(queries.map(item => item.query)).toEqual(['marquee hire South Wales']);
  });
});
