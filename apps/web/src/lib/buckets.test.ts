import { describe, expect, it } from 'vitest';
import type { AgentCard, CardState } from '@mirante/shared';
import { emptyTokenUsage } from '@mirante/shared';
import { bucketOf, groupAgents, orderAgents } from './buckets.js';

/** Ten minutes after the cards started: anything working is still live. */
const NOW = Date.parse('2026-09-25T10:10:00.000Z');

const card = (
  agentId: string,
  state: CardState,
  options: { startedAt?: string; endedAt?: string; lastEventAt?: string; limited?: boolean } = {},
): AgentCard =>
  ({
    sessionId: 's1',
    agentId,
    displayName: agentId,
    status:
      state === 'waiting_approval' || state === 'waiting_input' || state === 'rate_limited'
        ? { state, waitingOn: { summary: 'something' } }
        : { state },
    tokens: emptyTokenUsage(),
    startedAt: options.startedAt ?? '2026-09-25T10:00:00.000Z',
    ...(options.endedAt ? { endedAt: options.endedAt } : {}),
    ...(options.lastEventAt ? { lastEventAt: options.lastEventAt } : {}),
    ...(options.limited ? { stoppedAtLimit: { window: 'fiveHour' } } : {}),
    runningChildren: 0,
  }) as AgentCard;

describe('bucketOf', () => {
  it('puts a request for a person above everything else', () => {
    expect(bucketOf(card('a', 'waiting_approval'), NOW)).toBe('needs_you');
    expect(bucketOf(card('b', 'waiting_input'), NOW)).toBe('needs_you');
  });

  it('separates what broke from what a plan limit stopped', () => {
    expect(bucketOf(card('a', 'error'), NOW)).toBe('failed');
    expect(bucketOf(card('b', 'error', { limited: true }), NOW)).toBe('stopped');
    expect(bucketOf(card('c', 'rate_limited'), NOW)).toBe('stopped');
  });

  it('calls an agent that claims to work but went quiet what it is', () => {
    const quiet = card('a', 'tool_running', { lastEventAt: '2026-09-25T09:00:00.000Z' });
    expect(bucketOf(quiet, NOW)).toBe('no_signal');
    const busy = card('b', 'tool_running', { lastEventAt: '2026-09-25T10:09:00.000Z' });
    expect(bucketOf(busy, NOW)).toBe('working');
  });

  /**
   * "No signal" implies something might still be out there. When the session
   * closed, nothing is: those agents did not stall, they were cut short.
   */
  it('does not call an agent silent when its session closed under it', () => {
    const cut = card('a', 'tool_running', { lastEventAt: '2026-09-25T09:00:00.000Z' });
    expect(bucketOf(cut, NOW, true)).toBe('finished');
  });
});

describe('orderAgents', () => {
  it('ranks by what needs a person, then what runs, then the past', () => {
    const cards = [
      card('done', 'done', { endedAt: '2026-09-25T10:05:00.000Z' }),
      card('running', 'tool_running', { lastEventAt: '2026-09-25T10:09:00.000Z' }),
      card('broken', 'error'),
      card('asking', 'waiting_approval'),
      card('quiet', 'thinking', { lastEventAt: '2026-09-25T09:00:00.000Z' }),
    ];
    expect(orderAgents(cards, NOW).map((c) => c.agentId)).toEqual([
      'asking',
      'running',
      'broken',
      'quiet',
      'done',
    ]);
  });

  it('puts the longest-running agent first, so a new one appends', () => {
    const cards = [
      card('new', 'tool_running', {
        startedAt: '2026-09-25T10:08:00.000Z',
        lastEventAt: '2026-09-25T10:09:00.000Z',
      }),
      card('old', 'tool_running', {
        startedAt: '2026-09-25T10:01:00.000Z',
        lastEventAt: '2026-09-25T10:09:00.000Z',
      }),
    ];
    expect(orderAgents(cards, NOW).map((c) => c.agentId)).toEqual(['old', 'new']);
  });

  it('shows the most recently finished first among the past', () => {
    const cards = [
      card('early', 'done', { endedAt: '2026-09-25T10:01:00.000Z' }),
      card('late', 'done', { endedAt: '2026-09-25T10:08:00.000Z' }),
    ];
    expect(orderAgents(cards, NOW).map((c) => c.agentId)).toEqual(['late', 'early']);
  });
});

describe('groupAgents', () => {
  const lane = [
    card('asking', 'waiting_approval'),
    card('running', 'tool_running', { lastEventAt: '2026-09-25T10:09:00.000Z' }),
    card('broken', 'error'),
    card('limited', 'error', { limited: true }),
    card('quiet', 'thinking', { lastEventAt: '2026-09-25T09:00:00.000Z' }),
    card('done1', 'done', { endedAt: '2026-09-25T10:05:00.000Z' }),
    card('done2', 'done', { endedAt: '2026-09-25T10:06:00.000Z' }),
  ];

  it('folds away only the past, never a failure', () => {
    const { open, closed, counts } = groupAgents(lane, NOW);
    expect(open.map((c) => c.agentId)).toEqual(['asking', 'running', 'broken', 'limited']);
    expect(closed.map((g) => [g.bucket, g.cards.length])).toEqual([
      ['no_signal', 1],
      ['finished', 2],
    ]);
    expect(counts).toMatchObject({ needs_you: 1, working: 1, failed: 1, stopped: 1 });
  });

  it('leaves nothing to fold when every agent is still someone’s problem', () => {
    const { closed } = groupAgents([card('a', 'waiting_approval')], NOW);
    expect(closed).toEqual([]);
  });
});
