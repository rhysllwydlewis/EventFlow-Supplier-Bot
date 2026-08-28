import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/services/discovery.service.ts', 'utf8');

describe('discovery cycle', () => {
  it('skips a domain that is already a published EventFlow supplier before claiming a daily slot', () => {
    // A Hard Reset wipes candidate history so the operator can start over,
    // but must never make the bot forget a domain it has already published
    // -- otherwise every future discovery cycle re-crawls, re-extracts and
    // re-assesses (real crawl/AI spend) suppliers that are already live.
    // Checked before tryClaimDailyAcquisitionSlot so an already-published
    // domain doesn't even consume a daily acquisition slot, let alone a
    // crawl.
    expect(source).toContain(
      "import { getPublishedSupplierByDomain } from '../repositories/published-supplier.repository.js';",
    );
    const checkIndex = source.indexOf('await getPublishedSupplierByDomain(domain)');
    const claimIndex = source.indexOf('await tryClaimDailyAcquisitionSlot(');
    expect(checkIndex).toBeGreaterThan(-1);
    expect(checkIndex).toBeLessThan(claimIndex);
    expect(source).toContain('alreadyPublishedSkipped');
  });
});
