import { describe, expect, it } from 'vitest';
import { readWindow } from './plan.js';

const NOW = Date.parse('2026-09-21T09:30:00Z');

describe('readWindow', () => {
  it('shows a live reading', () => {
    expect(readWindow({ usedPercentage: 67, resetsAt: 1789952400 + 86400 }, NOW)).toEqual({
      state: 'known',
      percentage: 67,
      resetsAt: 1789952400 + 86400,
    });
  });

  it("refuses last night's number once its window has reset", () => {
    // 100% at the 5-hour window that reset at 22:00 the evening before.
    expect(readWindow({ usedPercentage: 100, resetsAt: 1789952400 }, NOW)).toEqual({
      state: 'reset',
    });
  });

  it('says unknown, not zero, when there is no reading', () => {
    expect(readWindow(undefined, NOW)).toEqual({ state: 'unknown' });
  });

  it('keeps a reading that carries no reset time', () => {
    expect(readWindow({ usedPercentage: 12 }, NOW)).toEqual({ state: 'known', percentage: 12 });
  });
});
