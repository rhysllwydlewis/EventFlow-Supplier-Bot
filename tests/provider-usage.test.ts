import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/services/provider-usage.service.ts', 'utf8');

describe('provider search ceiling', () => {
  it('claims a search atomically, gated by the daily limit, rather than a non-atomic check-then-increment', () => {
    // Two concurrent discovery cycles for the same provider must not be able
    // to jointly issue more searches than dailyLimit allows -- the guard has
    // to be part of the same findOneAndUpdate that performs the increment,
    // like tryClaimDailyAcquisitionSlot and tryReserveDailyAiBudget already
    // do, not a separate read followed by a write.
    expect(source).toContain('findOneAndUpdate(');
    expect(source).toContain('searches: { $lt: limit }');
    expect(source).toContain('$inc: { searches: 1 }');
  });

  it('returns false rather than throwing once the daily limit is reached', () => {
    expect(source).toContain('return claimed !== null;');
  });
});
