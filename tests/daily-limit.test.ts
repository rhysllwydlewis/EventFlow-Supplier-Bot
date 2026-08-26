import { describe, expect, it } from 'vitest';
import { remainingDailyAllowance } from '../src/services/daily-limit.service.js';

describe('daily acquisition allowance', () => {
  it('uses independent campaign and global counters', () => {
    expect(remainingDailyAllowance(3, 4, 10, 25)).toBe(7);
    expect(remainingDailyAllowance(3, 9, 50, 10)).toBe(1);
  });

  it('prevents multiple campaigns from exceeding the global cap', () => {
    expect(remainingDailyAllowance(0, 10, 10, 10)).toBe(0);
    expect(remainingDailyAllowance(1, 9, 10, 10)).toBe(1);
  });

  it('never returns a negative allowance', () => {
    expect(remainingDailyAllowance(12, 12, 10, 10)).toBe(0);
  });

  it('normalises negative counters and limits safely', () => {
    expect(remainingDailyAllowance(-2, -4, 10, 10)).toBe(10);
    expect(remainingDailyAllowance(0, 0, -1, 10)).toBe(0);
  });
});
