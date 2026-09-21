import { describe, expect, it } from 'vitest';
import { emptyTokenUsage, type AgentCard, type CardState } from '@mirante/shared';
import { SILENT_AFTER_MS, livenessOf } from './liveness.js';

const NOW = Date.parse('2026-09-21T10:00:00Z');
const card = (state: CardState, lastEventAt?: string): AgentCard =>
  ({
    sessionId: 's',
    agentId: 'a1',
    displayName: 'Explore',
    status: { state },
    tokens: emptyTokenUsage(),
    startedAt: '2026-09-20T22:13:35.000Z',
    runningChildren: 0,
    ...(lastEventAt ? { lastEventAt } : {}),
  }) as AgentCard;

describe('livenessOf', () => {
  it('believes a working card that was heard from recently', () => {
    expect(livenessOf(card('tool_running', '2026-09-21T09:58:00Z'), NOW)).toBe('live');
  });

  /** The Explore card: last event at 22:30 the evening before, finish never received. */
  it('stops believing a card that has been silent for hours', () => {
    expect(livenessOf(card('tool_running', '2026-09-20T22:30:35Z'), NOW)).toBe('silent');
  });

  it('allows a long quiet tool call up to the threshold', () => {
    const edge = new Date(NOW - SILENT_AFTER_MS).toISOString();
    expect(livenessOf(card('tool_running', edge), NOW)).toBe('live');
  });

  it('never calls a card live once its session has ended', () => {
    expect(livenessOf(card('thinking', '2026-09-21T09:59:00Z'), NOW, true)).toBe('silent');
  });

  it('leaves states that are not working alone', () => {
    expect(livenessOf(card('done', '2026-09-20T22:30:35Z'), NOW)).toBe('rest');
    expect(livenessOf(card('waiting_approval'), NOW)).toBe('rest');
  });
});
