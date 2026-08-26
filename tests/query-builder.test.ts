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
});
