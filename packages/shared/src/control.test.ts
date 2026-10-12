import { describe, expect, it } from 'vitest';
import { BoardProjector } from './projector.js';
import { completionOf, needsRecovery } from './control.js';
import type { DraftEvent, MiranteEvent } from './event.js';

let sequence = 0;
const event = (draft: Pick<DraftEvent, 'kind' | 'payload'> & Partial<DraftEvent>): MiranteEvent =>
  ({
    id: ++sequence,
    receivedTs: '2026-10-10T10:01:00.000Z',
    ts: '2026-10-10T10:00:00.000Z',
    source: 'sdk',
    sessionId: 'session',
    projectPath: '/tmp/project',
    agentId: 'main',
    ...draft,
  }) as MiranteEvent;
const start = () => {
  const projector = new BoardProjector();
  projector.apply(
    event({ kind: 'session.started', payload: { entrypoint: 'cli', cwd: '/tmp/project' } }),
  );
  projector.apply(
    event({
      kind: 'agent.started',
      agentId: 'worker',
      parentAgentId: 'main',
      payload: { agentType: 'general-purpose', spawnMode: 'async' },
    }),
  );
  return projector;
};
const worker = (p: BoardProjector) =>
  p.snapshot().sessions[0]!.cards.find((card) => card.agentId === 'worker')!;

describe('completion evidence and control replay', () => {
  it.each(['ok', 'interrupted', 'error'] as const)(
    'preserves explicit %s and its result during replay',
    (outcome) => {
      const p = start();
      p.apply(
        event({
          kind: 'agent.finished',
          agentId: 'worker',
          payload: { outcome, resultPreview: 'Resultado observado.' },
          ts: '2026-10-10T10:01:00.000Z',
        }),
      );
      expect(worker(p)).toMatchObject({ outcome, resultPreview: 'Resultado observado.' });
      expect(completionOf(worker(p))).toBe(
        outcome === 'ok' ? 'completed' : outcome === 'error' ? 'failed' : 'interrupted',
      );
      expect(needsRecovery(worker(p), Date.parse('2026-10-10T10:02:00.000Z'))).toBe(
        outcome !== 'ok',
      );
    },
  );

  it('a session close does not assert completion of unfinished children', () => {
    const p = start();
    p.apply(
      event({ kind: 'session.ended', payload: { reason: 'exit' }, ts: '2026-10-10T10:01:00.000Z' }),
    );
    expect(worker(p).outcome).toBeUndefined();
    expect(completionOf(worker(p))).toBe('unknown');
    expect(needsRecovery(worker(p), Date.parse('2026-10-10T10:02:00.000Z'), true)).toBe(true);
  });

  it('a genuine follow-up clears the old completion instead of leaving an interrupted badge on live work', () => {
    const p = start();
    p.apply(
      event({
        kind: 'agent.finished',
        agentId: 'worker',
        payload: { outcome: 'interrupted', resultPreview: 'Parou.' },
        ts: '2026-10-10T10:01:00.000Z',
      }),
    );
    p.apply(
      event({
        kind: 'agent.started',
        agentId: 'worker',
        parentAgentId: 'main',
        dedupeKey: 'follow-up-2',
        payload: { agentType: 'general-purpose', spawnMode: 'async', followUp: true },
        ts: '2026-10-10T10:02:00.000Z',
      }),
    );
    expect(worker(p).outcome).toBeUndefined();
    expect(worker(p).resultPreview).toBeUndefined();
    expect(worker(p).endedAt).toBeUndefined();
    expect(completionOf(worker(p))).toBeUndefined();
  });

  it('control acknowledgements neither create phantom tasks nor update their observed liveness', () => {
    const p = start();
    const before = structuredClone(worker(p));
    const payload = {
      runId: 'run-1',
      operation: 'verify' as const,
      status: 'completed' as const,
      requestedAt: '2026-10-10T10:03:00.000Z',
      finishedAt: '2026-10-10T10:04:00.000Z',
      verdict: 'pending' as const,
      summary: 'Faltam testes.',
    };
    p.apply(
      event({
        kind: 'agent.control.updated',
        agentId: 'worker',
        payload,
        ts: '2026-10-10T10:04:00.000Z',
      }),
    );
    expect(worker(p)).toEqual(before);
    expect(p.snapshot().controlRuns).toEqual([
      { ...payload, sessionId: 'session', agentId: 'worker' },
    ]);
    const empty = new BoardProjector();
    empty.apply(event({ kind: 'agent.control.updated', agentId: 'worker', payload }));
    expect(empty.snapshot().sessions).toEqual([]);
  });

  it('new observed work clears a plan stop even if no finish marker arrived', () => {
    const p = start();
    p.apply(
      event({
        kind: 'error.raised',
        agentId: 'worker',
        ts: '2026-10-10T10:01:00.000Z',
        payload: { kind: 'rate_limit', message: 'Limite do plano', limit: { window: 'fiveHour' } },
      }),
    );
    expect(completionOf(worker(p))).toBe('interrupted');
    p.apply(
      event({
        kind: 'tool.started',
        agentId: 'worker',
        ts: '2026-10-10T10:00:30.000Z',
        payload: { toolName: 'Read', toolUseId: 'old', summary: 'old.tsx' },
      }),
    );
    expect(worker(p).stoppedAtLimit).toBeDefined();
    p.apply(
      event({
        kind: 'tool.started',
        agentId: 'worker',
        ts: '2026-10-10T10:02:00.000Z',
        payload: { toolName: 'Read', toolUseId: 'new', summary: 'new.tsx' },
      }),
    );
    expect(worker(p).stoppedAtLimit).toBeUndefined();
    expect(completionOf(worker(p))).toBeUndefined();
    expect(worker(p).status.state).toBe('tool_running');
  });
});
