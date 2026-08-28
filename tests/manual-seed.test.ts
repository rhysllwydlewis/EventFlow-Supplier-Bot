import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/services/manual-seed.service.ts', 'utf8');

describe('manual supplier seeding', () => {
  it('rejects known non-supplier domains before spending crawl or acquisition budget', () => {
    // Manual seeding bypasses the discovery-time quality gate entirely (it's
    // an operator asserting "this is a real supplier"), so it needs its own
    // check against the same domain list -- otherwise a mistyped or
    // copy-pasted directory/government/UGC URL would spend crawl and AI
    // budget on a candidate that publication would refuse anyway, with no
    // feedback until someone noticed it stuck in review.
    expect(source).toContain(
      "import { isKnownNonSupplierDomain } from './discovery-result-quality.service.js';",
    );
    const checkIndex = source.indexOf('isKnownNonSupplierDomain(domain)');
    const suppressionIndex = source.indexOf("isSuppressed(domain, 'do_not_crawl')");
    const allowanceIndex = source.indexOf('remainingDailyAllowance(');
    expect(checkIndex).toBeGreaterThan(-1);
    expect(suppressionIndex).toBeGreaterThan(-1);
    // Checked alongside the existing suppression check, and before any
    // daily-allowance/slot-claiming work happens.
    expect(checkIndex).toBeGreaterThan(suppressionIndex);
    expect(checkIndex).toBeLessThan(allowanceIndex);
  });
});
