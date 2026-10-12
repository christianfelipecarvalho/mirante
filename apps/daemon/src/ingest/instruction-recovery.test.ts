import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MiranteEvent } from '@mirante/shared';
import { EventLog } from '../core/eventlog.js';
import { createThreadState, parseRolloutLines } from './codex/parse.js';
import { CodexWatcher } from './codex/watcher.js';
import { TranscriptWatcher } from './transcript/watcher.js';

const folders: string[] = [];
const folder = () => {
  const path = mkdtempSync(join(tmpdir(), 'mirante-instruction-recovery-'));
  folders.push(path);
  return path;
};
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});
const jsonl = (records: unknown[]) =>
  records.map((record) => JSON.stringify(record)).join('\n') + '\n';

describe('instruction recovery watchers', () => {
  it('backfills a delivered Codex instruction from disk, including partial UTF-8 reads, without duplicates after restart', () => {
    const directory = folder();
    const day = join(directory, '2026', '10', '10');
    mkdirSync(day, { recursive: true });
    const child = '01a0b4da-719b-72b3-b5c6-ec480fe56c59';
    const records = [
      {
        type: 'session_meta',
        timestamp: '2026-10-10T00:00:00Z',
        payload: {
          id: child,
          session_id: 'session-root',
          parent_thread_id: 'session-root',
          thread_source: 'subagent',
          agent_path: '/root/child',
          cwd: '/tmp/test',
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-10-10T00:00:00Z',
        payload: { type: 'task_started', turn_id: '01a0b4da-7999-72b3-b5c6-ec480fe56c59' },
      },
    ];
    const delivered = {
      type: 'response_item',
      timestamp: '2026-10-10T00:00:01Z',
      payload: {
        type: 'agent_message',
        id: 'delivered-1',
        author: '/root',
        recipient: '/root/child',
        content: [
          {
            type: 'input_text',
            text: 'Message Type: NEW_TASK\nTask name: /root/child\nSender: /root\nPayload:\nValide a operação.\n\n  Preserve a instrução completa.',
          },
        ],
      },
    };
    const path = join(day, `rollout-test-${child}.jsonl`);
    writeFileSync(path, jsonl([...records, delivered]));
    utimesSync(path, new Date(0), new Date(0));
    const stranger = '01a0b4da-0000-72b3-b5c6-ec480fe56c59';
    const unknownPath = join(day, `rollout-test-${stranger}.jsonl`);
    writeFileSync(
      unknownPath,
      jsonl([...records, delivered])
        .replaceAll(child, stranger)
        .replace('NEW_TASK', 'MESSAGE'),
    );
    utimesSync(unknownPath, new Date(0), new Date(0));
    const log = new EventLog(join(directory, 'events.db'));
    try {
      // Simulate the previous parser, which recorded the start and skipped delivery.
      log.appendMany(parseRolloutLines(createThreadState(), records).events);
      const received: MiranteEvent[] = [];
      const watcher = new CodexWatcher({
        sessionsDir: directory,
        log,
        onEvents: (events) => received.push(...events),
        readBudgetBytes: 17,
        knownThreadIds: new Set([child]),
      });
      watcher.reindexFromLog();
      for (let pass = 0; pass < 150; pass += 1) watcher.scan();
      const starts = received.filter((event) => event.kind === 'agent.started');
      expect(starts).toHaveLength(1);
      expect(received).toHaveLength(1);
      expect(received.every((event) => event.agentId === child)).toBe(true);
      expect(starts[0]?.payload).toMatchObject({
        brief: 'Valide a operação.\n\n  Preserve a instrução completa.',
        briefAvailability: 'captured',
      });
      expect(watcher.scan()).toBe(0);
      const restarted = new CodexWatcher({
        sessionsDir: directory,
        log,
        onEvents: () => {},
        knownThreadIds: new Set([child]),
      });
      restarted.reindexFromLog();
      expect(restarted.scan()).toBe(0);
      appendFileSync(
        path,
        jsonl([
          {
            type: 'response_item',
            timestamp: new Date().toISOString(),
            payload: {
              type: 'function_call',
              name: 'exec_command',
              call_id: 'fresh-call',
              arguments: '{"cmd":"pwd"}',
            },
          },
        ]),
      );
      expect(restarted.scan()).toBe(1);
      expect([...log.replay()].at(-1)?.kind).toBe('tool.started');
    } finally {
      log.close();
    }
  });

  it('rereads Claude when only the child metadata arrives, refining identity without duplicating a start', () => {
    const directory = folder();
    const project = join(directory, 'project');
    const children = join(project, 'session', 'subagents');
    mkdirSync(children, { recursive: true });
    const common = { sessionId: 'session', cwd: '/tmp/test', timestamp: '2026-10-10T00:00:00Z' };
    writeFileSync(
      join(project, 'session.jsonl'),
      jsonl([
        {
          ...common,
          type: 'assistant',
          uuid: 'spawn',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call-spawn',
                name: 'Agent',
                input: { prompt: 'Original assignment.' },
              },
            ],
          },
        },
      ]),
    );
    writeFileSync(
      join(children, 'agent-child.jsonl'),
      jsonl([
        {
          ...common,
          type: 'user',
          uuid: 'brief',
          parentUuid: null,
          isSidechain: true,
          agentId: 'child',
          message: { role: 'user', content: 'Original assignment.' },
        },
      ]),
    );
    const log = new EventLog(join(directory, 'events.db'));
    try {
      const received: MiranteEvent[] = [];
      const watcher = new TranscriptWatcher({
        projectsDir: directory,
        log,
        onEvents: (events) => received.push(...events),
        maxAgeMs: Infinity,
      });
      expect(watcher.scan()).toBeGreaterThan(0);
      const before = received.find((event) => event.kind === 'agent.started')!;
      received.length = 0;
      writeFileSync(
        join(children, 'agent-child.meta.json'),
        JSON.stringify({ agentType: 'reviewer', toolUseId: 'call-spawn' }),
      );
      expect(watcher.scan()).toBe(1);
      expect(received[0]).toMatchObject({
        kind: 'agent.started',
        dedupeKey: before.dedupeKey,
        parentAgentId: 'main',
        payload: { agentType: 'reviewer', brief: 'Original assignment.' },
      });
      expect(watcher.scan()).toBe(0);
      const restarted = new TranscriptWatcher({
        projectsDir: directory,
        log,
        onEvents: () => {},
        maxAgeMs: Infinity,
      });
      restarted.reindexFromLog();
      expect(restarted.scan()).toBe(0);
    } finally {
      log.close();
    }
  });
});

describe('archived Claude instruction repair', () => {
  it('reparses only known old sessions and only refines their known assignment facts', () => {
    const directory = folder();
    const project = join(directory, 'project');
    mkdirSync(project, { recursive: true });
    const ts = '2020-01-01T00:00:00.000Z';
    const make = (sessionId: string) => [
      {
        type: 'assistant',
        sessionId,
        cwd: '/tmp/test',
        timestamp: ts,
        uuid: `${sessionId}-call`,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: `${sessionId}-tool`,
              name: 'Agent',
              input: { prompt: 'Recovered complete instruction.' },
            },
          ],
        },
      },
      {
        type: 'user',
        sessionId,
        cwd: '/tmp/test',
        timestamp: ts,
        uuid: `${sessionId}-result`,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `${sessionId}-tool` }],
        },
        toolUseResult: { agentId: `${sessionId}-child` },
      },
      {
        type: 'assistant',
        sessionId,
        cwd: '/tmp/test',
        timestamp: ts,
        uuid: `${sessionId}-send`,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: `${sessionId}-message`,
              name: 'SendMessage',
              input: { type: 'broadcast', content: 'Recorded follow-up.' },
            },
          ],
        },
      },
    ];
    for (const id of ['known', 'unknown']) {
      const path = join(project, `${id}.jsonl`);
      writeFileSync(path, jsonl(make(id)));
      utimesSync(path, new Date(0), new Date(0));
    }
    const log = new EventLog(join(directory, 'events.db'));
    try {
      log.append({
        ts,
        source: 'hook',
        sessionId: 'known',
        projectPath: '/tmp/test',
        agentId: 'known-child',
        kind: 'agent.started',
        dedupeKey: 'agent.started:known-child',
        payload: { agentType: 'unknown', spawnMode: 'async' },
      });
      const received: MiranteEvent[] = [];
      const watcher = new TranscriptWatcher({
        projectsDir: directory,
        log,
        knownSessionIds: new Set(['known']),
        onEvents: (events) => received.push(...events),
      });
      watcher.reindexFromLog();
      expect(watcher.scan()).toBe(2);
      expect(received.map((event) => event.kind)).toEqual(['agent.started', 'agent.instruction']);
      expect(received.every((event) => event.sessionId === 'known')).toBe(true);
      expect(received[0]?.payload).toMatchObject({ brief: 'Recovered complete instruction.' });
      expect(watcher.scan()).toBe(0);
      const restarted = new TranscriptWatcher({
        projectsDir: directory,
        log,
        knownSessionIds: new Set(['known']),
        onEvents: () => {},
      });
      restarted.reindexFromLog();
      expect(restarted.scan()).toBe(0);
    } finally {
      log.close();
    }
  });
});
