import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardProjector, workProgress, type MiranteEvent } from '@mirante/shared';
import { EventLog } from '../../core/eventlog.js';
import { hookToEvents, type HookPayload } from '../hooks.js';
import { TranscriptWatcher } from './watcher.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const fixture = (agentId = 'main') => {
  const root = mkdtempSync(join(tmpdir(), 'mirante-plan-lifecycle-'));
  const project = join(root, 'project');
  const projectsDir = join(root, 'transcripts');
  const slug = join(projectsDir, 'project');
  mkdirSync(project);
  mkdirSync(slug, { recursive: true });
  const file = join(project, 'PLAN.md');
  const origin = Date.now() - 60_000;
  const at = (second: number) => new Date(origin + second * 1_000).toISOString();
  const content = (completed: number) =>
    '# Plan\n' +
    Array.from(
      { length: 4 },
      (_, index) => `- [${index < completed ? 'x' : ' '}] Step ${index + 1}`,
    ).join('\n');
  const write = (completed: number, second: number) => {
    writeFileSync(file, content(completed));
    utimesSync(file, new Date(at(second)), new Date(at(second)));
  };
  const base = { sessionId: 'session', cwd: project };
  const prompt = (second: number, id: string, text: string) => ({
    ...base,
    timestamp: at(second),
    type: 'user',
    uuid: id,
    promptId: id,
    message: { role: 'user', content: text },
  });
  const main: unknown[] = [prompt(1, 'request', 'Implement the requested feature')];
  const writes = [
    {
      ...base,
      timestamp: at(2),
      type: 'assistant',
      uuid: 'use',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'write',
            name: 'Write',
            input: { file_path: file, content: content(1) },
          },
        ],
      },
    },
    {
      ...base,
      timestamp: at(2),
      type: 'user',
      uuid: 'result',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'write', content: 'Written' }],
      },
      toolUseResult: { filePath: file, content: content(1) },
    },
  ];
  const jsonl = (path: string, lines: unknown[]) =>
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  if (agentId === 'main') main.push(...writes);
  else {
    const children = join(slug, 'session', 'subagents');
    mkdirSync(children, { recursive: true });
    jsonl(join(children, `agent-${agentId}.jsonl`), [
      prompt(1, 'child-request', 'Implement the child task'),
      ...writes,
    ]);
  }
  const flush = () => jsonl(join(slug, 'session.jsonl'), main);
  flush();
  write(1, 2);
  const log = new EventLog(':memory:');
  cleanups.push(() => {
    log.close();
    rmSync(root, { recursive: true, force: true });
  });
  let projector = new BoardProjector();
  const options = {
    projectsDir,
    log,
    onEvents: (events: MiranteEvent[]) => projector.applyAll(events),
  };
  const watcher = new TranscriptWatcher(options);
  watcher.scan();
  const hook = (name: string, second: number, extra: Partial<HookPayload> = {}) => {
    const events = hookToEvents(
      { hook_event_name: name, session_id: 'session', cwd: project, ...extra },
      { now: at(second) },
    );
    projector.applyAll(log.appendMany(events));
  };
  const card = () =>
    projector.snapshot().sessions[0]?.cards.find((card) => card.agentId === agentId);
  const restart = () => {
    projector = new BoardProjector();
    projector.applyAll(log.replay());
    const restarted = new TranscriptWatcher(options);
    restarted.reindexFromLog();
    return restarted;
  };
  return { watcher, log, write, hook, card, restart, main, prompt, flush, at };
};

describe('Markdown plan tracking across authoritative hooks', () => {
  it('freezes an ended session after a hook close, both live and after restart', () => {
    const f = fixture();
    f.write(2, 3);
    expect(f.watcher.scan()).toBe(1);
    expect(workProgress(f.card()?.plan).percent).toBe(50);
    f.hook('SessionEnd', 4);
    const count = f.log.count();
    f.write(3, 5);
    expect(f.watcher.scan()).toBe(0);
    expect(f.card()?.endedAt).toBe(f.at(4));
    expect(workProgress(f.card()?.plan).percent).toBe(50);
    const restarted = f.restart();
    expect(restarted.scan()).toBe(0);
    f.write(4, 6);
    expect(restarted.scan()).toBe(0);
    expect(workProgress(f.card()?.plan).percent).toBe(50);
    expect(f.log.count()).toBe(count);
  });

  it('honors SubagentStop without requiring a final transcript message', () => {
    const f = fixture('child');
    expect(workProgress(f.card()?.plan).percent).toBe(25);
    f.hook('SubagentStop', 3, { agent_id: 'child' });
    f.write(4, 4);
    expect(f.watcher.scan()).toBe(0);
    expect(f.card()?.endedAt).toBe(f.at(3));
    expect(workProgress(f.card()?.plan).percent).toBe(25);
    expect(f.restart().scan()).toBe(0);
    expect(workProgress(f.card()?.plan).percent).toBe(25);
  });

  it('captures a final file snapshot that was saved before the hook close exactly once', () => {
    const f = fixture();
    f.write(4, 3);
    f.hook('SessionEnd', 4);
    expect(f.watcher.scan()).toBe(1);
    expect(workProgress(f.card()?.plan).percent).toBe(100);
    expect(f.card()?.endedAt).toBe(f.at(4));
    expect(f.watcher.scan()).toBe(0);
    expect(f.restart().scan()).toBe(0);
  });

  it('follows a resumed continuation but does not reuse that plan for an unrelated request', () => {
    const f = fixture();
    f.hook('SessionEnd', 3);
    f.write(2, 4);
    expect(f.watcher.scan()).toBe(0);
    f.hook('SessionStart', 5, { source: 'resume' });
    f.main.push(f.prompt(6, 'continuation', 'continue'));
    f.flush();
    f.write(3, 7);
    f.watcher.scan();
    expect(f.card()?.endedAt).toBeUndefined();
    expect(workProgress(f.card()?.plan).percent).toBe(75);
    f.main.push(f.prompt(8, 'new-request', 'Implement an unrelated new feature'));
    f.flush();
    f.watcher.scan();
    expect(f.card()?.plan).toBeUndefined();
    f.write(4, 9);
    expect(f.watcher.scan()).toBe(0);
    expect(f.card()?.plan).toBeUndefined();
  });
});
