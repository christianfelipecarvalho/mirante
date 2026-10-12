import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardProjector, MAIN_AGENT_ID, type DraftEvent, type MiranteEvent } from '@mirante/shared';
import { EventLog } from '../../core/eventlog.js';
import { BRIEF_PREVIEW_LENGTH, preview } from '../../core/redact.js';
import { createThreadState, parseRolloutLines } from './parse.js';
import { CodexWatcher } from './watcher.js';

const ROOT = '01a0f000-0000-7000-8000-000000000010';
const CHILD = '01a0f000-0000-7000-8000-000000000030';
const CHILD_TURN = '01a0f000-0000-7000-8000-000000000040';
const NEXT_TURN = '01a0f000-0000-7000-8000-000000000050';
const TS = '2026-10-11T12:00:00.000Z';
const FINISHED_TS = '2026-10-11T12:00:05.000Z';
const NEXT_TS = '2026-10-11T12:00:10.000Z';
const REPORT =
  'Implemented the requested change.\n\nValidation:\n- pnpm check\n- pnpm build\n\n```ts\n  const result = true;\n```';
const meta = {
  timestamp: TS,
  type: 'session_meta',
  payload: {
    id: CHILD,
    session_id: ROOT,
    thread_source: 'subagent',
    parent_thread_id: ROOT,
    cwd: '/synthetic/project',
  },
};
const turn = (turnId = CHILD_TURN, timestamp = TS) => ({
  timestamp,
  type: 'event_msg',
  payload: { type: 'task_started', turn_id: turnId, root_turn_id: ROOT },
});
const finish = (result: unknown = REPORT, kind = 'task_complete', turnId = CHILD_TURN) => ({
  timestamp: FINISHED_TS,
  type: 'event_msg',
  payload: { type: kind, turn_id: turnId, duration_ms: 5000, last_agent_message: result },
});
const parse = (...records: unknown[]) => parseRolloutLines(createThreadState(), records);
const finishes = (events: readonly DraftEvent[]) =>
  events.filter(
    (event): event is Extract<DraftEvent, { kind: 'agent.finished' }> =>
      event.kind === 'agent.finished',
  );

describe('Codex returned reports', () => {
  it('keeps the native final report, paragraphs and code indentation with its own assignment', () => {
    const { events, warnings } = parse(meta, turn(), finish());
    expect(warnings).toEqual([]);
    expect(finishes(events)).toHaveLength(1);
    expect(finishes(events)[0]).toMatchObject({
      ts: FINISHED_TS,
      agentId: CHILD,
      parentAgentId: MAIN_AGENT_ID,
      sessionId: ROOT,
      payload: {
        outcome: 'ok',
        assignmentId: CHILD_TURN,
        handedBackTo: MAIN_AGENT_ID,
        durationMs: 5000,
        resultPreview: REPORT,
        resultAvailability: 'captured',
        resultCharCount: REPORT.length,
        resultTruncated: false,
      },
    });
  });

  it('normalizes Windows line endings without flattening the return', () => {
    const report = 'Return:\r\n\r\n  Keep indentation.\r\n';
    const [result] = finishes(parse(meta, turn(), finish(report)).events);
    expect(result?.payload.resultPreview).toBe('Return:\n\n  Keep indentation.');
    expect(result?.payload.resultCharCount).toBe(report.trim().length);
  });

  it('redacts sensitive text before storing any return', () => {
    const secret = 'sk-ant-exampleSecretToken12345';
    const report = `Validation:\n\nNever share ${secret} or person@example.com.\n\n  Keep layout.`;
    const { events } = parse(meta, turn(), finish(report));
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain('person@example.com');
    expect(finishes(events)[0]?.payload.resultPreview).toContain('\n\n  Keep layout.');
    expect(finishes(events)[0]?.payload.resultPreview).toContain('[redacted]');
    expect(finishes(events)[0]?.payload.resultCharCount).toBe(report.length);
    expect(finishes(events)[0]?.payload.resultTruncated).toBe(false);
  });

  it('keeps complete practical reports and explicitly marks the 64K ceiling', () => {
    const practical = 'Full result.\n'.repeat(1000);
    const [complete] = finishes(parse(meta, turn(), finish(practical)).events);
    expect(complete?.payload.resultPreview).toBe(practical.trim());
    expect(complete?.payload.resultTruncated).toBe(false);
    const pathological = 'x'.repeat(BRIEF_PREVIEW_LENGTH + 20);
    const [truncated] = finishes(parse(meta, turn(), finish(pathological)).events);
    expect(truncated?.payload.resultPreview).toHaveLength(BRIEF_PREVIEW_LENGTH);
    expect(truncated?.payload.resultPreview?.endsWith('…')).toBe(true);
    expect(truncated?.payload.resultCharCount).toBe(pathological.length);
    expect(truncated?.payload.resultTruncated).toBe(true);
  });

  it.each([undefined, null, 42, {}, [], '', '   '])(
    'reports missing final text instead of inventing a return (%j)',
    (result) => {
      // Explicit override keeps undefined distinct from finish()'s fixture default.
      const missing = { ...finish(), payload: { ...finish().payload, last_agent_message: result } };
      const [returned] = finishes(parse(meta, turn(), missing).events);
      expect(returned?.payload.resultAvailability).toBe('missing');
      expect(returned?.payload.resultPreview).toBeUndefined();
      expect(returned?.payload.resultTruncated).toBeUndefined();
      expect(returned?.payload.resultCharCount).toBeUndefined();
    },
  );

  it('keeps ciphertext out of the log and states that the return is encrypted', () => {
    const encrypted = `gAAAA${'x'.repeat(200)}`;
    const { events } = parse(meta, turn(), finish(encrypted));
    expect(JSON.stringify(events)).not.toContain('gAAAA');
    expect(finishes(events)[0]?.payload).toMatchObject({ resultAvailability: 'encrypted' });
    expect(finishes(events)[0]?.payload.resultPreview).toBeUndefined();
  });

  it('captures an explicit interruption return without reporting successful completion', () => {
    const [interrupted] = finishes(
      parse(meta, turn(), finish('Work was interrupted.', 'turn_aborted')).events,
    );
    expect(interrupted?.payload).toMatchObject({
      outcome: 'interrupted',
      resultAvailability: 'captured',
      resultPreview: 'Work was interrupted.',
    });
  });

  it('does not promote intermediate commentary to the final return when completion lacks text', () => {
    const commentary = {
      timestamp: '2026-10-11T12:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'I am still implementing the change.' },
    };
    const { events } = parse(meta, turn(), commentary, finish('', 'turn_aborted'));
    expect(events.some((event) => event.kind === 'agent.said')).toBe(true);
    expect(finishes(events)[0]?.payload).toMatchObject({
      outcome: 'interrupted',
      resultAvailability: 'missing',
    });
    expect(finishes(events)[0]?.payload.resultPreview).toBeUndefined();
  });

  it('excludes parent history and approval guardians from returned reports', () => {
    const inherited = parse(
      meta,
      turn(ROOT),
      finish('Inherited parent report.', 'task_complete', ROOT),
      turn(),
      finish('Own report.'),
    );
    expect(finishes(inherited.events).map((event) => event.payload.resultPreview)).toEqual([
      'Own report.',
    ]);
    expect(JSON.stringify(inherited.events)).not.toContain('Inherited parent report.');
    const guardian = {
      ...meta,
      payload: { ...meta.payload, source: { subagent: { other: 'guardian' } } },
    };
    expect(parse(guardian, turn(), finish()).events).toEqual([]);
  });

  it('keeps stable finish keys and source timestamps across restarts and incremental reading', () => {
    const records = [meta, turn(), finish()];
    const whole = parse(...records).events;
    const state = createThreadState();
    const batches = records.flatMap((record) => parseRolloutLines(state, [record]).events);
    expect(batches).toEqual(whole);
    expect(parse(...records).events).toEqual(whole);
    const first = finishes(whole)[0];
    const followUp = finishes(
      parse(
        meta,
        turn(),
        finish(),
        turn(NEXT_TURN, NEXT_TS),
        finish('Second report.', 'task_complete', NEXT_TURN),
      ).events,
    ).at(-1);
    expect(followUp?.dedupeKey).not.toBe(first?.dedupeKey);
    expect(followUp?.payload.assignmentId).toBe(NEXT_TURN);
  });

  it.each(['task_complete', 'turn_aborted'])(
    'keeps an older %s on its native assignment without clearing current tools or plans',
    (kind) => {
      const state = createThreadState();
      const newerRootPrompt = 'new-root-prompt';
      const newerTurn = {
        ...turn(NEXT_TURN, NEXT_TS),
        payload: { ...turn(NEXT_TURN, NEXT_TS).payload, root_turn_id: newerRootPrompt },
      };
      const shellCall = {
        timestamp: '2026-10-11T12:00:11.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'current-shell',
          arguments: '{"cmd":"pnpm check"}',
        },
      };
      const planCall = {
        timestamp: '2026-10-11T12:00:12.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'update_plan',
          call_id: 'current-plan',
          arguments: '{"plan":[{"step":"Current assignment","status":"in_progress"}]}',
        },
      };
      const staleFinish = {
        ...finish('Previous assignment report.', kind),
        timestamp: '2026-10-11T12:00:13.000Z',
      };
      const first = parseRolloutLines(state, [
        meta,
        turn(),
        newerTurn,
        shellCall,
        planCall,
        staleFinish,
      ]);
      const returned = finishes(first.events)[0];
      expect(returned?.payload.assignmentId).toBe(CHILD_TURN);
      expect(returned?.dedupeKey).toBe(`agent.finished:${CHILD}:${CHILD_TURN}`);
      expect(returned?.promptId).toBeUndefined();
      expect(state.turnId).toBe(NEXT_TURN);
      expect(state.promptId).toBe(newerRootPrompt);
      expect(state.openCalls).toEqual({ 'current-shell': 'Bash' });
      expect(state.pendingPlans.has('current-plan')).toBe(true);
      const next = parseRolloutLines(state, [
        {
          timestamp: '2026-10-11T12:00:14.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'current-plan',
            output: 'Plan updated',
          },
        },
        {
          timestamp: '2026-10-11T12:00:15.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'current-shell',
            output: 'Process exited with code 0',
          },
        },
      ]);
      expect(next.events.find((event) => event.kind === 'task.plan.updated')?.payload.scopeId).toBe(
        NEXT_TURN,
      );
      expect(next.events.some((event) => event.kind === 'tool.finished')).toBe(true);
      const projector = new BoardProjector();
      projector.applyAll(
        [...first.events, ...next.events].map((event, index) => ({
          ...event,
          id: index + 1,
          receivedTs: event.ts,
        })),
      );
      const child = projector.snapshot().sessions[0]?.cards.find((card) => card.agentId === CHILD);
      expect(child?.endedAt).toBeUndefined();
      expect(child?.outcome).toBeUndefined();
      expect(child?.resultPreview).toBeUndefined();
      expect(child?.plan?.scopeId).toBe(NEXT_TURN);
    },
  );

  it('does not idle the main agent on a late end for its previous native turn', () => {
    const rootMeta = { ...meta, payload: { id: ROOT, cwd: '/synthetic/project', source: 'cli' } };
    const state = createThreadState();
    parseRolloutLines(state, [rootMeta, turn(CHILD_TURN), turn(NEXT_TURN, NEXT_TS)]);
    const late = parseRolloutLines(state, [finish('Previous main result.')]);
    expect(late.events).toEqual([]);
    expect(state.turnId).toBe(NEXT_TURN);
  });
});

const dirs: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An old release retained only a flattened preview and no capture metadata. */
const legacy = (event: DraftEvent): DraftEvent => {
  if (event.kind !== 'agent.finished') return event;
  return {
    ...event,
    payload: {
      outcome: event.payload.outcome,
      durationMs: event.payload.durationMs,
      handedBackTo: event.payload.handedBackTo,
      resultPreview: preview(event.payload.resultPreview),
    },
  };
};

const fixture = (
  records: unknown[],
  oldEvents: DraftEvent[],
  knownThreadIds = new Set([ROOT, CHILD]),
) => {
  const home = mkdtempSync(join(tmpdir(), 'mirante-codex-return-'));
  dirs.push(home);
  const sessionsDir = join(home, 'sessions');
  const day = join(sessionsDir, '2026', '10', '11');
  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-10-11T12-00-00-${CHILD}.jsonl`);
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const old = Date.now() / 1000 - 3 * 24 * 60 * 60;
  utimesSync(path, old, old);
  const log = new EventLog(':memory:');
  logs.push(log);
  log.appendMany(oldEvents.map(legacy));
  const received: MiranteEvent[] = [];
  const options = {
    sessionsDir,
    log,
    knownThreadIds,
    onEvents: (events: MiranteEvent[]) => received.push(...events),
  };
  const watcher = new CodexWatcher(options);
  watcher.reindexFromLog();
  return { log, received, watcher, options };
};

describe('Codex return backfill', () => {
  it('enriches an observed historical finish without changing its clocks or lifecycle', () => {
    const records = [meta, turn(), finish()];
    const { watcher, received, log, options } = fixture(records, parse(...records).events);
    const projector = new BoardProjector();
    projector.applyAll(log.replay());
    const card = () =>
      projector.snapshot().sessions[0]?.cards.find((entry) => entry.agentId === CHILD);
    const before = card();
    expect(watcher.scan()).toBe(1);
    expect(received.map((event) => event.kind)).toEqual(['agent.finished']);
    expect(finishes(received)[0]?.payload.resultPreview).toBe(REPORT);
    projector.applyAll(received);
    expect(card()).toMatchObject({
      resultPreview: REPORT,
      startedAt: before?.startedAt,
      endedAt: before?.endedAt,
      lastEventAt: before?.lastEventAt,
      status: before?.status,
      outcome: before?.outcome,
    });
    const restarted = new CodexWatcher(options);
    restarted.reindexFromLog();
    expect(restarted.scan()).toBe(0);
  });

  it('never imports an unobserved historical finish even for a known child', () => {
    const records = [meta, turn(), finish()];
    const knownStart = parse(meta, turn()).events;
    const { watcher, received } = fixture(records, knownStart);
    expect(watcher.scan()).toBe(0);
    expect(received).toEqual([]);
  });

  it('repairs the recorded return while leaving a newer assignment active', () => {
    const records = [meta, turn(), finish(), turn(NEXT_TURN, NEXT_TS)];
    const { watcher, received, log } = fixture(records, parse(...records).events);
    const projector = new BoardProjector();
    projector.applyAll(log.replay());
    expect(watcher.scan()).toBe(1);
    expect(received.map((event) => event.kind)).toEqual(['agent.finished']);
    projector.applyAll(received);
    const lane = projector.snapshot().sessions[0];
    const card = lane?.cards.find((entry) => entry.agentId === CHILD);
    expect(card?.status.state).toBe('thinking');
    expect(card?.endedAt).toBeUndefined();
    expect(card?.resultPreview).toBeUndefined();
    expect(card?.lastEventAt).toBe(NEXT_TS);
    expect(lane?.cards.find((entry) => entry.agentId === MAIN_AGENT_ID)?.runningChildren).toBe(1);
  });

  it('leaves unrelated old rollout files unread even when their return was recorded elsewhere', () => {
    const records = [meta, turn(), finish()];
    const { watcher, received } = fixture(records, parse(...records).events, new Set([ROOT]));
    expect(watcher.scan()).toBe(0);
    expect(received).toEqual([]);
  });
});
