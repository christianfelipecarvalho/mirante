import { describe, expect, it } from 'vitest';
import { TokenLedger } from './token-ledger.js';
import { BoardProjector } from './projector.js';
import { addTokenUsage, emptyTokenUsage } from './usage.js';
import type { MiranteEventOf } from './event.js';

let id = 0;
const usage = (
  output: number,
  extra: Partial<MiranteEventOf<'usage.updated'>> = {},
): MiranteEventOf<'usage.updated'> => ({
  id: ++id,
  ts: '2026-10-10T15:00:00Z',
  receivedTs: '2026-10-10T15:00:00Z',
  source: 'transcript',
  sessionId: 's',
  agentId: 'main',
  projectPath: '/project',
  kind: 'usage.updated',
  dedupeKey: 'usage.updated:entry-a',
  payload: { scope: 'agent', tokens: { ...emptyTokenUsage(), output } },
  ...extra,
});
const response = (output: number, ts = '2026-10-10T15:01:00Z') =>
  usage(output, {
    ts,
    dedupeKey: 'usage.response:s:main:r1',
    payload: {
      scope: 'agent',
      responseId: 'r1',
      replacesUsageKeys: ['usage.updated:entry-a', 'usage.updated:entry-b'],
      tokens: { ...emptyTokenUsage(), output },
    },
  });

describe('response token accounting', () => {
  it('replaces partial counters and ignores repeated or older reports', () => {
    const ledger = new TokenLedger();
    expect(ledger.apply(response(2)).output).toBe(2);
    expect(ledger.apply(response(12, '2026-10-10T15:02:00Z')).output).toBe(10);
    expect(ledger.apply(response(12, '2026-10-10T15:02:00Z')).output).toBe(0);
    expect(ledger.apply(response(2)).output).toBe(0);
  });
  it('repairs legacy double charges without rewriting history, in either replay order', () => {
    const oldA = usage(4);
    const oldB = usage(10, { dedupeKey: 'usage.updated:entry-b' });
    const repaired = response(10);
    for (const events of [
      [oldA, oldB, repaired],
      [repaired, oldA, oldB],
      [oldA, repaired, oldB],
    ]) {
      const ledger = new TokenLedger();
      const total = events.reduce(
        (sum, event) => addTokenUsage(sum, ledger.apply(event)),
        emptyTokenUsage(),
      );
      expect(total.output).toBe(10);
      expect(ledger.apply(repaired).output).toBe(0);
    }
  });
  it('keeps identically named responses independent between agents and sessions', () => {
    const ledger = new TokenLedger();
    const event = response(10);
    expect(ledger.apply(event).output).toBe(10);
    expect(ledger.apply({ ...event, agentId: 'child' }).output).toBe(10);
    expect(ledger.apply({ ...event, sessionId: 'another' }).output).toBe(10);
  });
  it('subtracts a superseded lower-priority count instead of adding both sources', () => {
    const ledger = new TokenLedger();
    expect(ledger.apply({ ...response(7), source: 'otel' }).output).toBe(7);
    expect(ledger.apply(response(9)).output).toBe(2);
    expect(ledger.apply({ ...response(20), source: 'otel' }).output).toBe(0);
  });
  it('updates board measurement dates only on token changes and keeps newest cost reading', () => {
    const projector = new BoardProjector();
    projector.apply(response(10));
    projector.apply(response(10, '2026-10-10T15:02:00Z'));
    const cost = usage(0, {
      ts: '2026-10-10T15:03:00Z',
      source: 'statusline',
      dedupeKey: undefined,
      payload: { scope: 'session', tokens: emptyTokenUsage(), costUsd: 0.1234 },
    });
    projector.apply(cost);
    projector.apply({
      ...cost,
      id: ++id,
      ts: '2026-10-10T14:00:00Z',
      source: 'transcript',
      payload: { ...cost.payload, costUsd: 0.01 },
    });
    const lane = projector.snapshot().sessions[0]!;
    expect(lane.tokens.output).toBe(10);
    expect(lane.usageUpdatedAt).toBe('2026-10-10T15:01:00Z');
    expect(lane.cards[0]!.usageUpdatedAt).toBe(lane.usageUpdatedAt);
    expect(lane.costUsd).toBe(0.1234);
    expect(lane.costUpdatedAt).toBe(cost.ts);
    expect(lane.costSource).toBe('statusline');
  });
  it('projects append-only repair exactly once and does not reopen finished sessions', () => {
    const projector = new BoardProjector();
    const end = {
      id: ++id,
      receivedTs: '2026-10-10T16:00:00Z',
      ts: '2026-10-10T16:00:00Z',
      source: 'hook',
      sessionId: 's',
      agentId: 'main',
      projectPath: '/project',
      kind: 'session.ended',
      payload: {},
    } as const;
    projector.applyAll([
      usage(4),
      usage(10, { dedupeKey: 'usage.updated:entry-b' }),
      end,
      response(10),
    ]);
    const lane = projector.snapshot().sessions[0]!;
    expect(lane.tokens.output).toBe(10);
    expect(lane.endedAt).toBe(end.ts);
    expect(lane.cards[0]!.endedAt).toBe(end.ts);
  });
});
