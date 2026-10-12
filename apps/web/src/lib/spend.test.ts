import { describe, expect, it } from 'vitest';
import { emptyTokenUsage, type SessionLane } from '@mirante/shared';
import { formatLiveCost, formatLiveTokens, summarizeSpend } from './spend.js';

const lane = (extra: Partial<SessionLane> = {}): SessionLane => ({
  sessionId: 's1',
  projectPath: '/tmp/project',
  projectName: 'project',
  entrypoint: 'cli',
  harness: 'claude-code',
  startedAt: '2026-10-10T10:00:00.000Z',
  tokens: emptyTokenUsage(),
  cards: [],
  ...extra,
});

describe('live totals in the header', () => {
  it('makes a single token visible on an existing billion-token total', () => {
    expect(formatLiveTokens(1_000_000_001, 'pt-BR')).toBe('1.000.000.001');
    expect(formatLiveTokens(1_000_000_002, 'pt-BR')).not.toBe(
      formatLiveTokens(1_000_000_001, 'pt-BR'),
    );
  });
  it('shows sub-cent changes while explicitly formatting native USD', () => {
    expect(formatLiveCost(1.2345, 'en')).toBe('$1.2345');
    expect(formatLiveCost(1.2346, 'en')).not.toBe(formatLiveCost(1.2345, 'en'));
    expect(formatLiveCost(0, 'en')).toBe('$0.0000');
  });
  it('keeps unknown cost separate from a reported zero and dates each reading independently', () => {
    const summary = summarizeSpend([
      lane({
        costUsd: 0,
        costUpdatedAt: '2026-10-10T10:02:00.000Z',
        usageUpdatedAt: '2026-10-10T10:03:00.000Z',
        tokens: { input: 20, output: 3, cacheRead: 10, cacheCreation: 0 },
      }),
      lane({
        sessionId: 's2',
        harness: 'codex',
        usageUpdatedAt: '2026-10-10T10:04:00.000Z',
        tokens: { input: 7, output: 2, cacheRead: 5, cacheCreation: 0, thinking: 1 },
      }),
    ]);
    expect(summary).toMatchObject({
      tokens: 47,
      costUsd: 0,
      reportedSessions: 1,
      totalSessions: 2,
      usageUpdatedAt: '2026-10-10T10:04:00.000Z',
      costUpdatedAt: '2026-10-10T10:02:00.000Z',
    });
    expect(summarizeSpend([lane()]).costUsd).toBeUndefined();
  });
});
