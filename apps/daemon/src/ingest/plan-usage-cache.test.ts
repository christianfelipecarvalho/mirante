import { describe, expect, it } from 'vitest';
import { CACHE_MAX_AGE_MS, readCachedUsage } from './plan-usage-cache.js';

const NOW = new Date('2026-09-20T22:31:00.000Z');
const FETCHED_AT = Date.parse('2026-09-20T22:21:35.993Z');

/**
 * Shaped after the real `~/.claude.json`, including the fields that must not
 * come out the other side. See docs/EVENT_MAP.md §7.
 */
const stateFile = () => ({
  numStartups: 812,
  oauthAccount: {
    accountUuid: '00000000-0000-0000-0000-000000000000',
    emailAddress: 'someone@example.com',
    organizationType: 'claude_pro',
  },
  cachedUsageUtilization: {
    fetchedAtMs: FETCHED_AT,
    accountUuid: '00000000-0000-0000-0000-000000000000',
    utilization: {
      five_hour: { utilization: 67, resets_at: '2026-09-21T01:00:00.818208+00:00' },
      seven_day: { utilization: 57, resets_at: '2026-09-24T08:00:00.818235+00:00' },
      seven_day_opus: null,
      seven_day_breakdown: {
        rows: [{ key: 'claude_code', display_name: 'Claude Code', percent: 91 }],
      },
    },
  },
});

describe('reading the plan-usage figure Claude Code already cached', () => {
  it('reads both windows', () => {
    const result = readCachedUsage(stateFile(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reading.usage.fiveHour?.usedPercentage).toBe(67);
    expect(result.reading.usage.sevenDay?.usedPercentage).toBe(57);
  });

  /**
   * The same two instants the status line reports as epoch seconds and `/usage`
   * prints as local wall-clock. Three surfaces, one answer.
   */
  it('agrees with the other two surfaces on when the windows reset', () => {
    const result = readCachedUsage(stateFile(), NOW);
    if (!result.ok) throw new Error('expected a reading');
    expect(result.reading.usage.fiveHour?.resetsAt).toBe(1789952400);
    expect(result.reading.usage.sevenDay?.resetsAt).toBe(1790236800);
  });

  it('dates the reading when Claude Code fetched it, not when Mirante read it', () => {
    const result = readCachedUsage(stateFile(), NOW);
    if (!result.ok) throw new Error('expected a reading');
    expect(result.reading.fetchedAt).toBe('2026-09-20T22:21:35.993Z');
  });

  /**
   * The file this comes from also holds the account's email and identifiers.
   * Nothing but the two windows may survive the parse — this is the test that
   * says so, rather than a comment claiming it.
   */
  it('carries nothing out of that file but the two windows', () => {
    const result = readCachedUsage(stateFile(), NOW);
    if (!result.ok) throw new Error('expected a reading');

    expect(Object.keys(result.reading.usage).sort()).toEqual(['fiveHour', 'sevenDay']);
    expect(Object.keys(result.reading.usage.fiveHour ?? {}).sort()).toEqual([
      'resetsAt',
      'usedPercentage',
    ]);

    const serialized = JSON.stringify(result.reading);
    for (const secret of ['example.com', '00000000', 'claude_pro', 'numStartups', 'breakdown']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('refuses a figure too old to stand for the current window', () => {
    const old = new Date(FETCHED_AT + CACHE_MAX_AGE_MS + 1000);
    expect(readCachedUsage(stateFile(), old)).toEqual({ ok: false, reason: 'stale' });
  });

  it('reports an account with no windows as empty rather than as zero', () => {
    const file = stateFile();
    file.cachedUsageUtilization.utilization = {
      five_hour: null,
      seven_day: null,
    } as unknown as typeof file.cachedUsageUtilization.utilization;
    expect(readCachedUsage(file, NOW)).toEqual({ ok: false, reason: 'empty' });
  });

  it('says so when the key is not there at all', () => {
    expect(readCachedUsage({ numStartups: 1 }, NOW)).toEqual({ ok: false, reason: 'missing' });
  });

  /** Claude Code discards a cache written for another account; so does Mirante. */
  it('refuses a figure cached for a different account', () => {
    const file = stateFile();
    file.cachedUsageUtilization.accountUuid = '11111111-1111-1111-1111-111111111111';
    expect(readCachedUsage(file, NOW)).toEqual({ ok: false, reason: 'other-account' });
  });

  it('refuses a figure stamped in the future, as after the clock was set back', () => {
    const early = new Date(FETCHED_AT - 60_000);
    expect(readCachedUsage(stateFile(), early)).toEqual({ ok: false, reason: 'clock' });
  });

  it('keeps a window whose reset time is absent', () => {
    const file = stateFile();
    file.cachedUsageUtilization.utilization.five_hour = {
      utilization: 12,
    } as unknown as typeof file.cachedUsageUtilization.utilization.five_hour;
    const result = readCachedUsage(file, NOW);
    if (!result.ok) throw new Error('expected a reading');
    expect(result.reading.usage.fiveHour).toEqual({ usedPercentage: 12 });
  });
});
