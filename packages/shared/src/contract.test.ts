import { describe, expect, it } from 'vitest';
import { EVENT_KINDS } from './kinds.js';
import { miranteEventSchema, safeParseMiranteEvent } from './event.js';
import { cardStatusSchema, isWaitingState, WAITING_CARD_STATES } from './state.js';
import { addTokenUsage, emptyTokenUsage, totalTokens } from './usage.js';
import { dedupeKeys, shouldSupersede } from './dedupe.js';
import { MAIN_AGENT_ID } from './agent.js';
import type { DraftEvent } from './event.js';

const envelope = {
  id: 1,
  ts: '2026-09-19T12:00:00.000Z',
  receivedTs: '2026-09-19T12:00:00.010Z',
  source: 'hook' as const,
  sessionId: 'sess-1',
  projectPath: '/home/u/project',
  agentId: MAIN_AGENT_ID,
};

describe('event vocabulary', () => {
  it('defines a payload for every declared kind', () => {
    // Guards against adding a kind to EVENT_KINDS without teaching the union
    // about it, which would let an unvalidated event through the boundary.
    const inUnion = new Set(miranteEventSchema.options.map((o) => o.shape.kind.value));
    expect([...EVENT_KINDS].filter((k) => !inUnion.has(k))).toEqual([]);
    expect(inUnion.size).toBe(EVENT_KINDS.length);
  });

  it('rejects an unknown kind', () => {
    expect(safeParseMiranteEvent({ ...envelope, kind: 'tool.exploded', payload: {} }).success).toBe(
      false,
    );
  });

  it('rejects an event with no agent', () => {
    const { agentId: _agentId, ...withoutAgent } = envelope;
    const result = safeParseMiranteEvent({
      ...withoutAgent,
      kind: 'skill.invoked',
      payload: { skillName: 'review' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a well-formed event and narrows by kind', () => {
    const result = safeParseMiranteEvent({
      ...envelope,
      kind: 'tool.started',
      payload: { toolUseId: 'toolu_01A', toolName: 'Bash', summary: 'pnpm test' },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'tool.started') {
      expect(result.data.payload.toolName).toBe('Bash');
    }
  });
});

describe('card status', () => {
  it.each(WAITING_CARD_STATES)('rejects %s without a waiting reason', (state) => {
    expect(cardStatusSchema.safeParse({ state }).success).toBe(false);
  });

  it.each(WAITING_CARD_STATES)('accepts %s with a waiting reason', (state) => {
    const parsed = cardStatusSchema.safeParse({
      state,
      waitingOn: { summary: 'Approve: rm -rf build/', since: '2026-09-19T12:00:00.000Z' },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an active state with no waiting reason', () => {
    expect(cardStatusSchema.safeParse({ state: 'thinking' }).success).toBe(true);
  });

  it('classifies rate_limited as waiting, since it waits on the window resetting', () => {
    expect(isWaitingState('rate_limited')).toBe(true);
    expect(isWaitingState('tool_running')).toBe(false);
  });
});

describe('token usage', () => {
  it('counts cache tokens in the total but not thinking, which is a subset of output', () => {
    const usage = { input: 10, output: 100, cacheCreation: 500, cacheRead: 1000, thinking: 40 };
    expect(totalTokens(usage)).toBe(1610);
  });

  it('adds usages field by field', () => {
    const sum = addTokenUsage(
      { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 },
      { input: 10, output: 20, cacheCreation: 30, cacheRead: 40, thinking: 5 },
    );
    expect(sum).toEqual({ input: 11, output: 22, cacheCreation: 33, cacheRead: 44, thinking: 5 });
  });

  it('keeps thinking undefined when neither side reported it', () => {
    expect(addTokenUsage(emptyTokenUsage(), emptyTokenUsage()).thinking).toBeUndefined();
  });
});

describe('deduplication', () => {
  it('derives the same key from the same tool use across sources', () => {
    expect(dedupeKeys.toolStarted('toolu_01A')).toBe(dedupeKeys.toolStarted('toolu_01A'));
    expect(dedupeKeys.toolStarted('toolu_01A')).not.toBe(dedupeKeys.toolFinished('toolu_01A'));
  });

  it('lets the transcript supersede a hook, but not the reverse', () => {
    const draft = (source: DraftEvent['source']): DraftEvent => ({
      ts: envelope.ts,
      source,
      sessionId: envelope.sessionId,
      projectPath: envelope.projectPath,
      agentId: MAIN_AGENT_ID,
      kind: 'tool.finished',
      payload: { toolUseId: 'toolu_01A', toolName: 'Bash' },
    });
    expect(shouldSupersede(draft('transcript'), draft('hook'))).toBe(true);
    expect(shouldSupersede(draft('hook'), draft('transcript'))).toBe(false);
  });
});
