import { describe, expect, it } from 'vitest';
import { parseResetTime, parseUsageOutput } from './usage-command.js';

/**
 * The shape `/usage` printed on 2026-09-20, with the numbers replaced. Recorded
 * from a real run; see docs/EVENT_MAP.md §6.
 */
const REPORT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 67% used · resets Sep 20, 10pm (America/Sao_Paulo)',
  'Current week (all models): 57% used · resets Sep 24, 5am (America/Sao_Paulo)',
  '',
  "What's contributing to your limits usage?",
  'Approximate, based on local sessions on this machine — does not include other devices or claude.ai.',
  '',
  'Last 24h · 588 requests · 4 sessions',
  '  98% of your usage came from subagent-heavy sessions',
].join('\n');

const NOW = new Date('2026-09-20T22:20:00.000Z');

describe('parseUsageOutput', () => {
  it('reads both windows', () => {
    const { usage } = parseUsageOutput(REPORT, NOW);
    expect(usage.fiveHour?.usedPercentage).toBe(67);
    expect(usage.sevenDay?.usedPercentage).toBe(57);
  });

  /**
   * The strongest check available: the status line reported these same two
   * windows as epoch seconds, from a different surface, in the same hour. If the
   * prose parser and the structured field disagree, one of them is wrong.
   */
  it('resolves reset times to the epochs the status line reported independently', () => {
    const { usage } = parseUsageOutput(REPORT, NOW);
    expect(usage.fiveHour?.resetsAt).toBe(1789952400); // 2026-09-21T01:00:00Z
    expect(usage.sevenDay?.resetsAt).toBe(1790236800); // 2026-09-24T08:00:00Z
  });

  it('reports a window it does not recognize instead of dropping it', () => {
    const report = 'Current week (Opus): 12% used · resets Sep 24, 5am (America/Sao_Paulo)';
    const { usage, drift } = parseUsageOutput(report, NOW);
    expect(usage).toEqual({});
    expect(drift).toEqual([report]);
  });

  it('returns nothing rather than zero when there are no windows at all', () => {
    // What an API-key user sees: no subscription, so no plan windows.
    const { usage, drift } = parseUsageOutput('You are using the Anthropic API.', NOW);
    expect(usage).toEqual({});
    expect(drift).toEqual([]);
  });

  it('keeps the percentage when the reset time cannot be resolved', () => {
    const report = 'Current session: 40% used · resets Sep 20, 10pm (Mars/Olympus_Mons)';
    const { usage } = parseUsageOutput(report, NOW);
    expect(usage.fiveHour?.usedPercentage).toBe(40);
    expect(usage.fiveHour?.resetsAt).toBeUndefined();
  });

  it('accepts a window with no reset time printed', () => {
    const { usage } = parseUsageOutput('Current session: 3% used', NOW);
    expect(usage.fiveHour).toEqual({ usedPercentage: 3 });
  });
});

describe('parseResetTime', () => {
  it('reads minutes when they are printed', () => {
    const at = parseResetTime('Sep 21, 5:30am (America/Sao_Paulo)', NOW);
    expect(new Date(at! * 1000).toISOString()).toBe('2026-09-21T08:30:00.000Z');
  });

  it('reads midnight and noon on the 12-hour clock', () => {
    const midnight = parseResetTime('Sep 21, 12am (UTC)', NOW);
    const noon = parseResetTime('Sep 21, 12pm (UTC)', NOW);
    expect(new Date(midnight! * 1000).toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(new Date(noon! * 1000).toISOString()).toBe('2026-09-21T12:00:00.000Z');
  });

  /** The year is never printed, so a reset in January must not resolve to the year just ended. */
  it('crosses the year boundary forwards', () => {
    const at = parseResetTime('Jan 2, 9am (UTC)', new Date('2026-12-31T23:00:00.000Z'));
    expect(new Date(at! * 1000).toISOString()).toBe('2027-01-02T09:00:00.000Z');
  });

  it('resolves a zone that is observing daylight saving', () => {
    // New York is on EDT in September: 8pm local is midnight UTC the next day.
    const at = parseResetTime('Sep 20, 8pm (America/New_York)', NOW);
    expect(new Date(at! * 1000).toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });

  it('gives up on text it does not understand', () => {
    expect(parseResetTime('in about two hours', NOW)).toBeUndefined();
    expect(parseResetTime('Foo 20, 10pm (UTC)', NOW)).toBeUndefined();
  });
});
