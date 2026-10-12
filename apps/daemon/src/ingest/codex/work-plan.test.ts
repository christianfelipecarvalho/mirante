import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BoardProjector,
  MAIN_AGENT_ID,
  workProgress,
  type DraftEvent,
  type MiranteEvent,
} from '@mirante/shared';
import { EventLog } from '../../core/eventlog.js';
import { createThreadState, parseRolloutLines } from './parse.js';
import { CodexWatcher } from './watcher.js';

const ROOT = '01a0f000-0000-7000-8000-000000000010';
const TURN = '01a0f000-0000-7000-8000-000000000020';
const CHILD = '01a0f000-0000-7000-8000-000000000030';
const CHILD_TURN = '01a0f000-0000-7000-8000-000000000040';
const NEXT_TURN = '01a0f000-0000-7000-8000-000000000050';
const TS = '2026-10-11T12:00:00.000Z';
const CALL_TS = '2026-10-11T12:00:02.000Z';
const OUTPUT_TS = '2026-10-11T12:00:03.000Z';
const STEP = { step: 'Implement the planned change', status: 'in_progress' };

const meta = (payload: Record<string, unknown> = {}) => ({
  timestamp: TS,
  type: 'session_meta',
  payload: { id: ROOT, cwd: '/synthetic/project', source: 'cli', ...payload },
});
const turn = (turnId = TURN, rootTurnId?: string) => ({
  timestamp: '2026-10-11T12:00:01.000Z',
  type: 'event_msg',
  payload: {
    type: 'task_started',
    turn_id: turnId,
    ...(rootTurnId ? { root_turn_id: rootTurnId } : {}),
  },
});
const call = (callId = 'plan-1', plan: unknown = [STEP], custom = false) => ({
  timestamp: CALL_TS,
  type: 'response_item',
  payload: {
    type: custom ? 'custom_tool_call' : 'function_call',
    name: 'update_plan',
    call_id: callId,
    ...(custom ? { input: JSON.stringify({ plan }) } : { arguments: JSON.stringify({ plan }) }),
  },
});
const output = (
  callId = 'plan-1',
  result: unknown = 'Plan updated',
  custom = false,
  fields: Record<string, unknown> = {},
) => ({
  timestamp: OUTPUT_TS,
  type: 'response_item',
  payload: {
    type: custom ? 'custom_tool_call_output' : 'function_call_output',
    call_id: callId,
    output: result,
    ...fields,
  },
});
const plans = (events: readonly DraftEvent[]) =>
  events.filter(
    (event): event is Extract<DraftEvent, { kind: 'task.plan.updated' }> =>
      event.kind === 'task.plan.updated',
  );
const parse = (...records: unknown[]) => parseRolloutLines(createThreadState(), records);

describe('confirmed Codex work plans', () => {
  it('captures the successful native plan with its owner, source time and turn context', () => {
    const { events, warnings } = parse(
      meta(),
      turn(),
      call('plan-1', [
        { step: 'Read the code', status: 'completed' },
        STEP,
        { step: 'Validate the result', status: 'pending' },
      ]),
      output(),
    );
    expect(warnings).toEqual([]);
    expect(plans(events)).toHaveLength(1);
    expect(plans(events)[0]).toMatchObject({
      ts: OUTPUT_TS,
      source: 'codex-rollout',
      sessionId: ROOT,
      agentId: MAIN_AGENT_ID,
      correlationId: 'plan-1',
      promptId: TURN,
      payload: {
        planId: `codex:${ROOT}:${TURN}`,
        scopeId: TURN,
        sourceTool: 'update_plan',
        completeness: 'full',
      },
    });
    expect(plans(events)[0]?.payload.steps.map(({ text, status }) => ({ text, status }))).toEqual([
      { text: 'Read the code', status: 'completed' },
      { text: STEP.step, status: 'in_progress' },
      { text: 'Validate the result', status: 'pending' },
    ]);
    expect(events.some((event) => event.kind === 'tool.started')).toBe(false);
  });

  it('does not update progress while the call is still pending', () => {
    const state = createThreadState();
    const first = parseRolloutLines(state, [meta(), turn(), call()]);
    expect(plans(first.events)).toEqual([]);
    const confirmed = parseRolloutLines(state, [output()]);
    expect(plans(confirmed.events)).toHaveLength(1);
    expect(state.pendingPlans.size).toBe(0);
  });

  it.each([
    'Error: invalid plan',
    'Script failed\nTypeError: invalid plan',
    'Process exited with code 1',
    '',
    'Unknown result',
    'Plan updated\nError: rolled back',
    '{"error":"invalid plan"}',
  ])('does not infer success from a failed or unknown result (%s)', (result) => {
    const state = createThreadState();
    const { events } = parseRolloutLines(state, [meta(), turn(), call(), output('plan-1', result)]);
    expect(plans(events)).toEqual([]);
    expect(state.pendingPlans.size).toBe(0);
  });

  it.each([{ is_error: true }, { error: 'failed' }, { success: false }, { status: 'failed' }])(
    'honours an explicit failed result even when the text mentions success (%j)',
    (fields) => {
      const { events } = parse(
        meta(),
        turn(),
        call(),
        output('plan-1', 'Plan updated', false, fields),
      );
      expect(plans(events)).toEqual([]);
    },
  );

  it('supports native custom calls and text-part outputs without changing tool activity', () => {
    const { events } = parse(
      meta(),
      turn(),
      call('custom-plan', [STEP], true),
      output('custom-plan', [{ type: 'text', text: 'Plan updated' }], true),
    );
    expect(plans(events)).toHaveLength(1);
    expect(events.filter((event) => event.kind.startsWith('tool.'))).toEqual([]);
  });

  it('redacts the plan before storing it, including the pending state', () => {
    const state = createThreadState();
    const secret = 'sk-ant-exampleSecretToken12345';
    const first = parseRolloutLines(state, [
      meta(),
      turn(),
      call('private-plan', [{ step: `Check ${secret} for person@example.com`, status: 'pending' }]),
    ]);
    expect(plans(first.events)).toEqual([]);
    expect(JSON.stringify([...state.pendingPlans.values()])).not.toContain(secret);
    const { events } = parseRolloutLines(state, [output('private-plan')]);
    expect(JSON.stringify(plans(events))).not.toContain(secret);
    expect(plans(events)[0]?.payload.steps[0]?.text).toContain('[redacted]');
    expect(plans(events)[0]?.payload.steps[0]?.text).not.toContain('person@example.com');
  });

  it('leaves normal open calls intact while capturing a plan in parallel', () => {
    const state = createThreadState();
    const normalCall = {
      timestamp: CALL_TS,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'shell-1',
        arguments: '{"cmd":"pnpm check"}',
      },
    };
    parseRolloutLines(state, [meta(), turn(), normalCall, call()]);
    expect(state.openCalls).toEqual({ 'shell-1': 'Bash' });
    const { events } = parseRolloutLines(state, [
      output(),
      output('shell-1', 'Process exited with code 0'),
    ]);
    expect(plans(events)).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'tool.finished')).toHaveLength(1);
    expect(state.openCalls).toEqual({});
  });

  it('does not attribute a delayed acknowledgement to a newer turn', () => {
    const { events } = parse(meta(), turn(), call(), turn(NEXT_TURN), output());
    expect(plans(events)[0]?.promptId).toBe(TURN);
    expect(plans(events)[0]?.payload.scopeId).toBe(TURN);
    expect(plans(events)[0]?.ts).toBe(OUTPUT_TS);
  });

  it('uses the main agent’s root prompt scope while keeping its turn correlation separate', () => {
    const { events } = parse(meta(), turn(NEXT_TURN, TURN), call(), output());
    expect(plans(events)[0]?.promptId).toBe(TURN);
    expect(plans(events)[0]?.payload.scopeId).toBe(TURN);
    expect(plans(events)[0]?.payload.planId).toBe(`codex:${ROOT}:${TURN}`);
  });

  it('records an explicitly cleared plan instead of inferring completed work', () => {
    const { events } = parse(meta(), turn(), call('clear-plan', []), output('clear-plan'));
    expect(plans(events)).toHaveLength(1);
    expect(plans(events)[0]?.payload.steps).toEqual([]);
  });

  it('bounds unanswered plan proposals without touching unrelated tool calls', () => {
    const state = createThreadState();
    parseRolloutLines(state, [
      meta(),
      turn(),
      ...Array.from({ length: 257 }, (_, index) => call(`plan-${index}`)),
    ]);
    expect(state.pendingPlans.size).toBe(256);
    const { events } = parseRolloutLines(state, [output('plan-0'), output('plan-256')]);
    expect(plans(events).map((event) => event.correlationId)).toEqual(['plan-256']);
  });

  it.each(['task_complete', 'turn_aborted'])('discards unconfirmed proposals after %s', (kind) => {
    const state = createThreadState();
    const { events } = parseRolloutLines(state, [
      meta(),
      turn(),
      call(),
      { timestamp: OUTPUT_TS, type: 'event_msg', payload: { type: kind, turn_id: TURN } },
      output(),
    ]);
    expect(plans(events)).toEqual([]);
    expect(state.pendingPlans.size).toBe(0);
  });

  it('keeps a stable plan identity within one scope and a distinct identity for a new turn', () => {
    const { events } = parse(
      meta(),
      turn(),
      call(),
      output(),
      call('plan-2', [{ step: STEP.step, status: 'completed' }]),
      output('plan-2'),
      turn(NEXT_TURN),
      call('plan-3'),
      output('plan-3'),
    );
    const [first, second, next] = plans(events);
    expect(first?.payload.planId).toBe(second?.payload.planId);
    expect(first?.dedupeKey).not.toBe(second?.dedupeKey);
    expect(next?.payload.planId).not.toBe(first?.payload.planId);
  });

  it.each([
    null,
    {},
    [{ step: 'Missing status' }],
    [{ step: 'Unknown status', status: 'done' }],
    [{ step: '', status: 'completed' }],
  ])('ignores incomplete or corrupt snapshots without producing progress (%j)', (plan) => {
    const { events, warnings } = parse(meta(), turn(), call('broken', plan), output('broken'));
    expect(plans(events)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('does not log malformed JSON arguments or treat a stray acknowledgement as progress', () => {
    const original = call();
    const broken = {
      ...original,
      payload: { ...original.payload, arguments: '{secret: invalid JSON' },
    };
    const { events, warnings } = parse(meta(), turn(), broken, output());
    expect(plans(events)).toEqual([]);
    expect(warnings).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('invalid JSON');
    expect(plans(parse(meta(), turn(), output()).events)).toEqual([]);
  });

  it('rejects oversized full snapshots without dropping steps to inflate progress', () => {
    const tooMany = Array.from({ length: 501 }, (_, index) => ({
      step: `Step ${index + 1}`,
      status: 'completed',
    }));
    expect(
      plans(parse(meta(), turn(), call('too-many', tooMany), output('too-many')).events),
    ).toEqual([]);
    const tooLong = [{ step: 'x'.repeat(4001), status: 'completed' }];
    expect(
      plans(parse(meta(), turn(), call('too-long', tooLong), output('too-long')).events),
    ).toEqual([]);
  });

  it('ignores script text that merely mentions the update_plan helper', () => {
    const { events } = parse(
      meta(),
      turn(),
      {
        timestamp: CALL_TS,
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'script-plan',
          input: 'const text = "tools.update_plan({ plan: [] })";',
        },
      },
      output('script-plan'),
    );
    expect(plans(events)).toEqual([]);
  });

  it('replays stable events regardless of incremental batch boundaries', () => {
    const records = [meta(), turn(), call(), output(), call('plan-2'), output('plan-2')];
    const whole = parse(...records).events;
    const state = createThreadState();
    const incremental = records.flatMap((record) => parseRolloutLines(state, [record]).events);
    expect(incremental).toEqual(whole);
    expect(parse(...records).events).toEqual(whole);
    expect(plans(parse(meta(), turn(), call(), output(), output()).events)).toHaveLength(1);
  });

  it('captures only the subagent’s own plan and preserves its parent prompt correlation', () => {
    const { events } = parse(
      meta({ id: CHILD, session_id: ROOT, thread_source: 'subagent', parent_thread_id: ROOT }),
      turn(),
      call('inherited-plan'),
      output('inherited-plan'),
      turn(CHILD_TURN, TURN),
      call('own-plan'),
      output('own-plan'),
    );
    expect(plans(events)).toHaveLength(1);
    expect(plans(events)[0]).toMatchObject({
      agentId: CHILD,
      parentAgentId: MAIN_AGENT_ID,
      sessionId: ROOT,
      promptId: TURN,
      correlationId: 'own-plan',
      payload: { scopeId: CHILD_TURN },
    });
    const start = events.find((event) => event.kind === 'agent.started');
    expect(start?.payload.assignmentId).toBe(CHILD_TURN);
  });

  it.each(['native', 'legacy'])(
    'does not apply an old child plan whose confirmation arrives after a new assignment (%s starts)',
    (format) => {
      const state = createThreadState();
      const oldOutputTs = '2026-10-11T12:00:05.000Z';
      const newAssignmentTs = '2026-10-11T12:00:04.000Z';
      const { events } = parseRolloutLines(state, [
        meta({ id: CHILD, session_id: ROOT, thread_source: 'subagent', parent_thread_id: ROOT }),
        turn(CHILD_TURN, TURN),
        call('old-complete', [{ step: 'Previous assignment', status: 'completed' }]),
        { ...turn(NEXT_TURN, TURN), timestamp: newAssignmentTs },
        { ...output('old-complete'), timestamp: oldOutputTs },
      ]);
      const starts = events.filter((event) => event.kind === 'agent.started');
      expect(starts.map((event) => event.payload.assignmentId)).toEqual([CHILD_TURN, NEXT_TURN]);
      expect(starts.at(-1)?.payload.followUp).toBe(true);
      expect(plans(events)[0]).toMatchObject({
        ts: oldOutputTs,
        payload: { scopeId: CHILD_TURN },
      });
      const projector = new BoardProjector();
      let nextId = 0;
      const apply = (drafts: DraftEvent[]) =>
        drafts.forEach((draft) => {
          const normalized =
            format === 'legacy' && draft.kind === 'agent.started'
              ? { ...draft, payload: { ...draft.payload, assignmentId: undefined } }
              : draft;
          projector.apply({ ...normalized, id: ++nextId, receivedTs: draft.ts });
        });
      const child = () =>
        projector.snapshot().sessions[0]?.cards.find((card) => card.agentId === CHILD);
      apply(events);
      expect(child()?.plan).toBeUndefined();
      expect(child()?.lastEventAt).toBe(newAssignmentTs);
      const current = parseRolloutLines(state, [
        {
          ...call('current-pending', [{ step: 'Current assignment', status: 'pending' }]),
          timestamp: '2026-10-11T12:00:06.000Z',
        },
        { ...output('current-pending'), timestamp: '2026-10-11T12:00:07.000Z' },
      ]);
      apply(current.events);
      expect(child()?.plan?.scopeId).toBe(NEXT_TURN);
      expect(workProgress(child()?.plan).percent).toBe(0);
    },
  );

  it('excludes inherited fork history and guardian plans', () => {
    const forked = parse(
      meta({ id: CHILD, forked_from_id: ROOT }),
      turn(),
      call('inherited'),
      output('inherited'),
      turn(CHILD_TURN),
      call('own'),
      output('own'),
    );
    expect(plans(forked.events).map((event) => event.correlationId)).toEqual(['own']);
    const guardian = parse(
      meta({ source: { subagent: { other: 'guardian' } } }),
      turn(),
      call(),
      output(),
    );
    expect(guardian.events).toEqual([]);
  });
});

const dirs: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const watcherFixture = (records: unknown[], knownThreadIds = new Set([ROOT])) => {
  const home = mkdtempSync(join(tmpdir(), 'mirante-codex-plan-'));
  dirs.push(home);
  const sessionsDir = join(home, 'sessions');
  const day = join(sessionsDir, '2026', '10', '11');
  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-10-11T12-00-00-${ROOT}.jsonl`);
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const old = Date.now() / 1000 - 3 * 24 * 60 * 60;
  utimesSync(path, old, old);
  const log = new EventLog(':memory:');
  logs.push(log);
  const received: MiranteEvent[] = [];
  const watcher = new CodexWatcher({
    sessionsDir,
    log,
    knownThreadIds,
    onEvents: (events) => received.push(...events),
  });
  return { sessionsDir, path, log, received, watcher, knownThreadIds };
};

describe('Codex plan backfill', () => {
  it('repairs only a known historical session’s confirmed plans without reactivating execution', () => {
    const { watcher, received, log, sessionsDir, knownThreadIds } = watcherFixture([
      meta(),
      turn(),
      call(),
      output(),
      call('plan-2', [{ step: STEP.step, status: 'completed' }]),
      output('plan-2'),
      {
        timestamp: OUTPUT_TS,
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: TURN },
      },
    ]);
    expect(watcher.scan()).toBe(2);
    expect(received.map((event) => event.kind)).toEqual(['task.plan.updated', 'task.plan.updated']);
    const latest = received.at(-1);
    expect(latest?.kind === 'task.plan.updated' && latest.payload.steps[0]?.status).toBe(
      'completed',
    );
    const restart = new CodexWatcher({
      sessionsDir,
      log,
      knownThreadIds,
      onEvents: (events) => received.push(...events),
    });
    restart.reindexFromLog();
    expect(restart.scan()).toBe(0);
    expect(received).toHaveLength(2);
  });

  it('does not import unrelated old sessions just to discover progress', () => {
    const { watcher, received } = watcherFixture([meta(), turn(), call(), output()], new Set());
    expect(watcher.scan()).toBe(0);
    expect(received).toEqual([]);
  });

  it('does not backfill a plan into an unknown root session from a known filename', () => {
    const { watcher, received } = watcherFixture([
      meta({ session_id: CHILD }),
      turn(),
      call(),
      output(),
    ]);
    expect(watcher.scan()).toBe(0);
    expect(received).toEqual([]);
  });

  it('confirms a historically pending plan only when its actual acknowledgement is appended', () => {
    const { watcher, received, path } = watcherFixture([meta(), turn(), call()]);
    expect(watcher.scan()).toBe(0);
    appendFileSync(path, JSON.stringify(output()) + '\n');
    expect(watcher.scan()).toBe(1);
    expect(received.map((event) => event.kind)).toEqual(['task.plan.updated']);
    expect(received[0]?.ts).toBe(OUTPUT_TS);
  });
});
