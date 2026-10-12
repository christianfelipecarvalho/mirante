import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BoardProjector,
  emptyTokenUsage,
  type DraftEvent,
  type MiranteEvent,
} from '@mirante/shared';
import { parseSessionTranscript } from './transcript/parse.js';
import { TranscriptWatcher } from './transcript/watcher.js';
import { createThreadState, parseRolloutLines } from './codex/parse.js';
import { EventLog } from '../core/eventlog.js';

const start = {
  type: 'user',
  uuid: 'prompt',
  sessionId: 'known',
  cwd: '/project',
  timestamp: '2020-01-01T00:00:00Z',
  message: { content: 'Synthetic task' },
};
const part = (uuid: string, output: number, second = 1) => ({
  type: 'assistant',
  uuid,
  sessionId: 'known',
  cwd: '/project',
  timestamp: `2020-01-01T00:00:0${second}Z`,
  message: {
    id: 'response-1',
    model: 'claude-test',
    content: [],
    usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: 100 },
  },
});
const parse = (lines: unknown[]) => parseSessionTranscript({ mainLines: lines }).events;
const numbered = (events: DraftEvent[], from = 0): MiranteEvent[] =>
  events.map(
    (event, index) => ({ ...event, id: index + from + 1, receivedTs: event.ts }) as MiranteEvent,
  );

describe('native usage recovery', () => {
  it('streams a response from partial to complete without charging input/cache again', () => {
    const projector = new BoardProjector();
    const initial = parse([start, part('a', 0)]);
    projector.applyAll(numbered(initial));
    expect(projector.snapshot().sessions[0]!.tokens).toMatchObject({
      input: 2,
      output: 0,
      cacheRead: 100,
    });
    const full = parse([start, part('a', 0), part('b', 30, 2), part('c', 30, 3)]);
    const usages = full.filter((event) => event.kind === 'usage.updated');
    expect(usages).toHaveLength(1);
    expect(usages[0]!.payload).toMatchObject({
      responseId: 'response-1',
      replacesUsageKeys: ['usage.updated:a', 'usage.updated:b', 'usage.updated:c'],
    });
    projector.applyAll(numbered(full, initial.length));
    expect(projector.snapshot().sessions[0]!.tokens).toMatchObject({
      input: 2,
      output: 30,
      cacheRead: 100,
    });
  });
  it('observes a rewritten UUID too, even without a provider response id', () => {
    const first = part('same', 0);
    const last = part('same', 12, 2);
    delete (first.message as { id?: string }).id;
    delete (last.message as { id?: string }).id;
    const projector = new BoardProjector();
    projector.applyAll(numbered(parse([start, first])));
    projector.applyAll(numbered(parse([start, last]), 100));
    expect(projector.snapshot().sessions[0]!.tokens.output).toBe(12);
  });
  it('uses native cumulative cost snapshots and stable origin dates, not the read clock', () => {
    const lines = [
      start,
      part('a', 4),
      { type: 'cost-state', sessionId: 'known', totalCostUSD: 1.25 },
      {
        type: 'system',
        subtype: 'local_command',
        uuid: 'report',
        sessionId: 'known',
        timestamp: '2020-01-01T00:00:02Z',
        usageReport: { session: { total_cost_usd: 1.75 } },
      },
      { type: 'cost-state', sessionId: 'known', totalCostUSD: -5 },
    ];
    const events = parse(lines);
    const costs = events.filter(
      (event): event is Extract<DraftEvent, { kind: 'usage.updated' }> =>
        event.kind === 'usage.updated' && event.payload.costUsd !== undefined,
    );
    expect(costs.map((event) => [event.ts, event.payload.costUsd])).toEqual([
      ['2020-01-01T00:00:01Z', 1.25],
      ['2020-01-01T00:00:02Z', 1.75],
    ]);
    expect(parse(lines)).toEqual(events);
    const projector = new BoardProjector();
    projector.applyAll(numbered(events));
    expect(projector.snapshot().sessions[0]!.costUsd).toBe(1.75);
    expect(projector.snapshot().sessions[0]!.costUpdatedAt).toBe('2020-01-01T00:00:02Z');
    expect(
      parse([start, { type: 'cost-state', sessionId: 'known' }]).some(
        (event) => event.kind === 'usage.updated',
      ),
    ).toBe(false);
  });
  it('backfills only known historical usage, repairs legacy totals, and emits nothing twice after restart', () => {
    const home = mkdtempSync(join(tmpdir(), 'mirante-usage-repair-'));
    const project = join(home, 'project');
    mkdirSync(project);
    const records = [
      start,
      part('a', 4),
      part('b', 10, 2),
      { type: 'cost-state', sessionId: 'known', totalCostUSD: 0.1234 },
    ];
    for (const sessionId of ['known', 'unrelated']) {
      const path = join(project, `${sessionId}.jsonl`);
      writeFileSync(
        path,
        records.map((entry) => JSON.stringify({ ...entry, sessionId })).join('\n') + '\n',
      );
      utimesSync(path, new Date(0), new Date(0));
    }
    const log = new EventLog(join(home, 'events.db'));
    try {
      log.appendMany(
        [4, 10].map((output, index): DraftEvent => ({
          ts: `2020-01-01T00:00:0${index + 1}Z`,
          source: 'transcript',
          sessionId: 'known',
          agentId: 'main',
          projectPath: '/project',
          kind: 'usage.updated',
          dedupeKey: `usage.updated:${index ? 'b' : 'a'}`,
          payload: {
            scope: 'agent',
            tokens: { ...emptyTokenUsage(), input: 2, output, cacheRead: 100 },
          },
        })),
      );
      log.append({
        ts: '2020-01-01T00:00:03Z',
        source: 'hook',
        sessionId: 'known',
        agentId: 'main',
        projectPath: '/project',
        kind: 'session.ended',
        payload: {},
      });
      const received: MiranteEvent[] = [];
      const options = {
        projectsDir: home,
        log,
        knownSessionIds: new Set(['known']),
        onEvents: (events: MiranteEvent[]) => received.push(...events),
      };
      const watcher = new TranscriptWatcher(options);
      watcher.reindexFromLog();
      expect(watcher.scan()).toBe(2);
      expect(
        received.every((event) => event.kind === 'usage.updated' && event.sessionId === 'known'),
      ).toBe(true);
      expect(watcher.scan()).toBe(0);
      const restart = new TranscriptWatcher(options);
      restart.reindexFromLog();
      expect(restart.scan()).toBe(0);
      const projector = new BoardProjector();
      projector.applyAll(log.replay());
      const lane = projector.snapshot().sessions[0]!;
      expect(lane.tokens).toMatchObject({ input: 2, output: 10, cacheRead: 100 });
      expect(lane.costUsd).toBe(0.1234);
      expect(lane.endedAt).toBe('2020-01-01T00:00:03Z');
    } finally {
      log.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('keeps native Codex response accounting separate from context token_count reports', () => {
    const thread = '01a0b4a4-e6d8-76f2-aad9-a3383586f8a3';
    const events = parseRolloutLines(createThreadState(), [
      {
        type: 'session_meta',
        payload: { id: thread, cwd: '/project' },
        timestamp: '2026-10-10T00:00:00Z',
      },
      {
        type: 'token_usage_record',
        timestamp: '2026-10-10T00:00:01Z',
        payload: {
          thread_id: thread,
          response_id: 'response',
          usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-10-10T00:00:01Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 100, output_tokens: 10 },
            last_token_usage: { input_tokens: 100, output_tokens: 10 },
            model_context_window: 1000,
          },
        },
      },
    ]).events;
    const projector = new BoardProjector();
    projector.applyAll(numbered(events));
    projector.applyAll(numbered(events, 100));
    const lane = projector.snapshot().sessions[0]!;
    expect(lane.tokens).toMatchObject({ input: 20, output: 10, cacheRead: 80 });
    expect(lane.costUsd).toBeUndefined();
  });
});
