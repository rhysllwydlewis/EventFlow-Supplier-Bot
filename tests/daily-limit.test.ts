import { describe, expect, it } from 'vitest';
import { remainingDailyAllowance } from '../src/services/daily-limit.service.js';

describe('daily acquisition allowance', () => {
  it('uses the lower campaign/global hard limit', () => {
    expect(remainingDailyAllowance(3, 10, 25)).toBe(7);
    expect(remainingDailyAllowance(3, 50, 10)).toBe(7);
  });

  it('never returns a negative allowance', () => {
    expect(remainingDailyAllowance(12, 10, 10)).toBe(0);
  });

  it('normalises invalid negative counters and limits safely', () => {
    expect(remainingDailyAllowance(-2, 10, 10)).toBe(10);
    expect(remainingDailyAllowance(0, -1, 10)).toBe(0);
  });
});
