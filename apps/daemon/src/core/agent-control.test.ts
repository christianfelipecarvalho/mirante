import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyTokenUsage,
  type AgentCard,
  type BoardState,
  type DraftEvent,
  type SessionLane,
} from '@mirante/shared';
import { AgentController, type ControlLauncher, type ControlProcess } from './agent-control.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const codexAgentId = '22222222-2222-4222-8222-222222222222';
const earlier = '2026-10-10T10:00:00.000Z';
const now = new Date('2026-10-10T11:00:00.000Z');
const paths: string[] = [];
const controllers: AgentController[] = [];
class ProcessDouble extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = null;
  pid = undefined;
  kill = vi.fn(() => true);
  complete(agentId: string, verdict = 'pending', extra: Record<string, unknown> = {}) {
    this.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { agentId, verdict, summary: 'Verificação encontrou trabalho restante no componente.' }, ...extra })}\n`,
    );
    this.emit('close', 0);
  }
}
const makeCard = (agentId: string): AgentCard => ({
  agentId,
  sessionId,
  status: { state: 'done' },
  outcome: agentId === 'main' ? 'ok' : 'interrupted',
  startedAt: earlier,
  endedAt: earlier,
  lastEventAt: earlier,
  tokens: emptyTokenUsage(),
  runningChildren: 0,
  task: 'Revisar componente',
});
const setup = (
  harness: 'claude-code' | 'codex' = 'claude-code',
  ids = ['worker-a', 'worker-b'],
  timeoutMs?: number,
) => {
  const home = mkdtempSync(join(tmpdir(), 'mirante-control-'));
  paths.push(home);
  const lane: SessionLane = {
    sessionId,
    projectPath: home,
    projectName: 'control',
    harness,
    entrypoint: 'cli',
    startedAt: earlier,
    endedAt: earlier,
    tokens: emptyTokenUsage(),
    cards: [makeCard('main'), ...ids.map(makeCard)],
  };
  const board: BoardState = {
    lastEventId: 0,
    sessions: [lane],
    timeline: [],
    pendingApprovals: [],
  };
  const events: DraftEvent[] = [];
  const children: ProcessDouble[] = [];
  const launch = vi.fn<ControlLauncher>(() => {
    const child = new ProcessDouble();
    children.push(child);
    return child as unknown as ControlProcess;
  });
  // Use the common process interface, with explicit exit acknowledgements.
  const stop = vi.fn((child: ControlProcess, signal: NodeJS.Signals) => {
    (child as unknown as ProcessDouble).emit('close', null, signal);
  });
  const controller = new AgentController({
    home,
    now: () => now,
    snapshot: () => board,
    launch,
    terminate: stop,
    timeoutMs,
    append: (drafts) => {
      events.push(...drafts);
      for (const event of drafts)
        if (event.kind === 'agent.control.updated') {
          const run = { ...event.payload, sessionId: event.sessionId, agentId: event.agentId };
          const index = board.controlRuns?.findIndex((old) => old.runId === run.runId) ?? -1;
          if (index < 0) (board.controlRuns ??= []).push(run);
          else board.controlRuns![index] = run;
        }
    },
  });
  controllers.push(controller);
  return { controller, board, lane, events, launch, children, stop, home };
};
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('explicit agent recovery', () => {
  it('runs nothing until requested; verifies a Claude child through its actual coordinator', () => {
    const { controller, launch, children, board, lane, events } = setup();
    expect(launch).not.toHaveBeenCalled();
    const before = structuredClone(lane.cards);
    expect(controller.request(sessionId, ['worker-a'], 'verify').ok).toBe(true);
    const [command, args, options] = launch.mock.calls[0]!;
    expect(command).toBe('claude');
    expect(args).toContain(sessionId);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(lane.projectPath);
    children[0]!.emit('spawn');
    children[0]!.complete('worker-a', 'pending');
    expect(board.controlRuns?.[0]).toMatchObject({ status: 'completed', verdict: 'pending' });
    expect(lane.cards).toEqual(before);
    expect(events.every((event) => event.kind === 'agent.control.updated')).toBe(true);
  });

  it('queues Claude children serially and starts the next only after confirmed exit', () => {
    const { controller, launch, children, board } = setup();
    const result = controller.request(sessionId, ['worker-a', 'worker-b'], 'resume');
    expect(result.ok && result.runIds.length).toBe(2);
    expect(launch).toHaveBeenCalledTimes(1);
    children[0]!.emit('spawn');
    expect(board.controlRuns?.map((run) => run.status)).toEqual(['running', 'queued']);
    children[0]!.complete('worker-a');
    expect(launch).toHaveBeenCalledTimes(2);
    children[1]!.complete('worker-b', 'blocked');
    expect(board.controlRuns?.[1]).toMatchObject({ status: 'completed', verdict: 'blocked' });
  });

  it('refuses unknown, live and already queued targets without creating another process', () => {
    const { controller, launch, lane } = setup();
    expect(controller.request(sessionId, ['other'], 'resume')).toEqual({
      ok: false,
      reason: 'unknown-agent',
    });
    lane.endedAt = undefined;
    lane.cards[1]!.endedAt = undefined;
    lane.cards[1]!.status = { state: 'thinking' };
    lane.cards[1]!.lastEventAt = now.toISOString();
    expect(controller.request(sessionId, ['worker-a'], 'resume')).toEqual({
      ok: false,
      reason: 'already-running',
    });
    lane.cards[1]!.status = { state: 'done' };
    expect(controller.request(sessionId, ['worker-a'], 'resume').ok).toBe(true);
    expect(controller.request(sessionId, ['worker-a'], 'resume')).toEqual({
      ok: false,
      reason: 'already-running',
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('stops owned executions and cancels queued ones without signalling observed agents', () => {
    const { controller, board, children, launch, stop } = setup();
    const result = controller.request(sessionId, ['worker-a', 'worker-b'], 'resume');
    if (!result.ok) throw new Error('request failed');
    expect(controller.stop(sessionId, ['33333333-3333-4333-8333-333333333333'])).toEqual({
      ok: false,
      reason: 'not-owned',
    });
    expect(stop).not.toHaveBeenCalled();
    expect(controller.stop(sessionId, [result.runIds[1]!]).ok).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    children[0]!.emit('spawn');
    expect(controller.stop(sessionId, [result.runIds[0]!]).ok).toBe(true);
    expect(stop).toHaveBeenCalledExactlyOnceWith(children[0], 'SIGINT');
    expect(board.controlRuns?.map((run) => run.status)).toEqual(['interrupted', 'interrupted']);
  });

  it.each([
    { name: 'missing result', output: { type: 'result', subtype: 'success' }, code: 0 },
    {
      name: 'wrong agent',
      output: {
        type: 'result',
        subtype: 'success',
        structured_output: { agentId: 'other', verdict: 'completed', summary: 'Done' },
      },
      code: 0,
    },
    {
      name: 'failed native turn',
      output: {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        structured_output: { agentId: 'worker-a', verdict: 'completed', summary: 'Done' },
      },
      code: 1,
    },
  ])('does not invent task completion for $name', ({ output, code }) => {
    const { controller, children, board } = setup();
    controller.request(sessionId, ['worker-a'], 'verify');
    children[0]!.stdout.write(`${JSON.stringify(output)}\n`);
    children[0]!.emit('close', code);
    expect(board.controlRuns?.[0]).toMatchObject({ status: 'failed', verdict: 'unknown' });
  });

  it('permission denial takes precedence over an optimistic model report', () => {
    const { controller, children, board } = setup();
    controller.request(sessionId, ['worker-a'], 'resume');
    children[0]!.complete('worker-a', 'completed', { permission_denials: [{ tool_name: 'Edit' }] });
    expect(board.controlRuns?.[0]).toMatchObject({
      status: 'failed',
      verdict: 'blocked',
      reason: 'permission-required',
    });
  });

  it('stopping the entire queue never launches a waiting child during cancellation', () => {
    const { controller, launch, stop, children, board } = setup('claude-code', [
      'worker-a',
      'worker-b',
      'worker-c',
    ]);
    controller.request(sessionId, [], 'resume');
    children[0]!.emit('spawn');
    expect(controller.stop(sessionId, []).ok).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(board.controlRuns?.every((run) => run.status === 'interrupted')).toBe(true);
  });

  it('resumes the actual Codex child UUID with read-only verification and validates JSONL acknowledgement', () => {
    const { controller, launch, children, board } = setup('codex', [codexAgentId]);
    controller.request(sessionId, [codexAgentId], 'verify');
    const [command, args] = launch.mock.calls[0]!;
    expect(command).toBe('codex');
    expect(args).toContain('--no-daemon');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args[args.indexOf('resume') + 1]).toBe(codexAgentId);
    const schema = JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1]!, 'utf8')) as {
      properties: { agentId: { const: string } };
    };
    expect(schema.properties.agentId.const).toBe(codexAgentId);
    children[0]!.stdout.write(
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ agentId: codexAgentId, verdict: 'completed', summary: 'Testes confirmados; não há trabalho restante.' }) } })}\n`,
    );
    children[0]!.stdout.write('{"type":"turn.completed"}\n');
    children[0]!.emit('close', 0);
    expect(board.controlRuns?.[0]).toMatchObject({ status: 'completed', verdict: 'completed' });
    expect(controller.request(sessionId, [codexAgentId], 'resume')).toEqual({
      ok: false,
      reason: 'completed-agent',
    });
  });

  it('reports missing executables and redacts captured failure messages', () => {
    const { controller, children, board } = setup();
    controller.request(sessionId, ['worker-a'], 'resume');
    children[0]!.stderr.write('Cannot run with sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890');
    children[0]!.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
    expect(board.controlRuns?.[0]).toMatchObject({ status: 'failed', reason: 'cli-not-found' });
    expect(board.controlRuns?.[0]?.summary).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('cancels a timed-out recovery and waits for its process acknowledgement', async () => {
    vi.useFakeTimers();
    const { controller, children, board, stop } = setup('claude-code', ['worker-a'], 50);
    controller.request(sessionId, ['worker-a'], 'verify');
    children[0]!.emit('spawn');
    await vi.advanceTimersByTimeAsync(51);
    expect(stop).toHaveBeenCalledWith(children[0], 'SIGINT');
    expect(board.controlRuns?.[0]).toMatchObject({
      status: 'failed',
      reason: 'timeout',
      verdict: 'unknown',
    });
  });
});
