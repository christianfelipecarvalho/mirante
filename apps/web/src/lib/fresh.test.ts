import { describe, expect, it } from 'vitest';

/**
 * The hook itself needs a renderer; its rule does not. This pins the rule so a
 * rewrite of the hook cannot quietly change what "new" means.
 */
const newSince = (ids: number[], previous: number | undefined): number[] =>
  previous === undefined ? [] : ids.filter((id) => id > previous);

describe('deciding what just arrived', () => {
  it('marks nothing on first sight', () => {
    // Everything is new when you open the page, and a screen that lights up all
    // at once says nothing about what changed.
    expect(newSince([1, 2, 3], undefined)).toEqual([]);
  });

  it('marks only ids above the last high-water mark', () => {
    expect(newSince([1, 2, 3, 4, 5], 3)).toEqual([4, 5]);
  });

  it('marks nothing when the list only shrank', () => {
    expect(newSince([1, 2], 5)).toEqual([]);
  });
});
