import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardProjector, type DraftEvent, type MiranteEvent, workProgress } from '@mirante/shared';
import { EventLog } from '../../core/eventlog.js';
import { MarkdownPlanFiles } from './plan-files.js';
import { TranscriptWatcher } from './watcher.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirante-plan-file-'));
  dirs.push(dir);
  return dir;
};
const at = (second: number) => new Date(Date.UTC(2026, 8, 1, 12, 0, second)).toISOString();
const content = (completed: number) =>
  '# Plano de implementação\n\n**Progresso: 99%**\n' +
  Array.from({ length: 4 }, (_, i) => `- [${i < completed ? 'x' : ' '}] Etapa ${i + 1}`).join('\n');
const write = (path: string, text: string, second: number) => {
  writeFileSync(path, text);
  utimesSync(path, new Date(at(second)), new Date(at(second)));
};
const plan = (
  projectPath: string,
  agentId = 'main',
): Extract<DraftEvent, { kind: 'task.plan.updated' }> => ({
  ts: at(2),
  source: 'transcript',
  sessionId: 'session',
  projectPath,
  agentId,
  promptId: 'request',
  dedupeKey: `task.plan.updated:${agentId}:write`,
  kind: 'task.plan.updated',
  payload: {
    planId: `markdown:${agentId}:request`,
    scopeId: 'request',
    sourceTool: 'Markdown',
    sourceFile: 'PLANO.md',
    completeness: 'full',
    steps: Array.from({ length: 4 }, (_, i) => ({
      id: `step-${i + 1}`,
      text: `Etapa ${i + 1}`,
      status: i === 0 ? 'completed' : 'pending',
    })),
  },
});
const prompt = (projectPath: string): Extract<DraftEvent, { kind: 'prompt.submitted' }> => ({
  ts: at(1),
  source: 'transcript',
  sessionId: 'session',
  projectPath,
  agentId: 'main',
  kind: 'prompt.submitted',
  promptId: 'request',
  payload: { promptId: 'request', preview: 'Implement the requested feature', charCount: 31 },
});
const progress = (event: ReturnType<MarkdownPlanFiles['read']>[number]) =>
  workProgress({ ...event.payload, updatedAt: event.ts });

describe('explicit Markdown plan file tracking', () => {
  it('follows changes outside Write/Edit, counts checkboxes, and preserves owner and scope', () => {
    const project = directory();
    const file = join(project, 'PLANO.md');
    write(file, content(1), 2);
    const files = new MarkdownPlanFiles();
    const recorded = [prompt(project), plan(project)];
    files.remember('session', recorded, false);
    expect(files.read('session')).toEqual([]);
    write(file, content(2), 3);
    const updated = files.read('session');
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      source: 'plan-file',
      agentId: 'main',
      promptId: 'request',
      payload: { scopeId: 'request', sourceFile: 'PLANO.md' },
    });
    expect(progress(updated[0]!)).toMatchObject({ completed: 2, total: 4, percent: 50 });
    expect(Date.parse(updated[0]!.ts)).toBeGreaterThan(Date.parse(at(3)));
    expect(files.read('session')).toEqual([]);
    files.remember('session', recorded, false);
    expect(files.read('session')).toEqual([]);
    write(file, content(1), 4);
    expect(progress(files.read('session')[0]!).percent).toBe(25);
  });

  it('stops following a previous assignment and never reads unregistered or historical files', () => {
    const project = directory();
    write(join(project, 'PLANO.md'), content(4), 5);
    const files = new MarkdownPlanFiles();
    files.remember('session', [prompt(project)], false);
    expect(files.read('session')).toEqual([]);
    files.remember('session', [prompt(project), plan(project)], true);
    expect(files.read('session')).toEqual([]);
    files.remember(
      'session',
      [
        prompt(project),
        plan(project),
        {
          ...prompt(project),
          ts: at(4),
          promptId: 'next',
          payload: { promptId: 'next', preview: 'Build a new feature', charCount: 19 },
        },
      ],
      false,
    );
    expect(files.read('session')).toEqual([]);
  });

  it('does not present stale numeric progress for deleted or malformed checklists and recovers', () => {
    const project = directory();
    const file = join(project, 'PLANO.md');
    const files = new MarkdownPlanFiles();
    files.remember('session', [prompt(project), plan(project)], false);
    const missing = files.read('session');
    expect(missing[0]?.payload.completeness).toBe('partial');
    expect(progress(missing[0]!).percent).toBeUndefined();
    expect(files.read('session')).toEqual([]);
    write(file, content(2), 3);
    expect(progress(files.read('session')[0]!).percent).toBe(50);
    write(file, '# Plano\n- [x] Valid\n- [?] Malformed', 4);
    expect(progress(files.read('session')[0]!).percent).toBeUndefined();
    write(file, content(2), 5);
    expect(progress(files.read('session')[0]!).percent).toBe(50);
  });

  it('recovers after deletion and restart even when a restored file keeps its old mtime', () => {
    const project = directory();
    const file = join(project, 'PLANO.md');
    write(file, content(2), 3);
    const recorded = [prompt(project), plan(project)];
    const files = new MarkdownPlanFiles();
    files.remember('session', recorded, false);
    const first = files.read('session')[0]!;
    rmSync(file);
    const missing = files.read('session')[0]!;
    const restarted = new MarkdownPlanFiles();
    restarted.restore(first);
    restarted.restore(missing);
    restarted.remember('session', recorded, false);
    expect(restarted.read('session')).toEqual([]);
    write(file, content(2), 3);
    const restored = restarted.read('session')[0]!;
    expect(progress(restored).percent).toBe(50);
    expect(restored.ts >= missing.ts).toBe(true);
    expect(restored.dedupeKey).not.toBe(first.dedupeKey);
    const projector = new BoardProjector();
    projector.applyAll(
      [...recorded, first, missing, restored].map((event, index) => ({
        ...event,
        id: index + 1,
        receivedTs: event.ts,
      })) as MiranteEvent[],
    );
    expect(workProgress(projector.snapshot().sessions[0]?.cards[0]?.plan).percent).toBe(50);
  });

  it('never promotes a shared child checklist to full coverage', () => {
    const project = directory();
    write(join(project, 'PLANO.md'), content(4), 3);
    const shared = plan(project, 'child');
    shared.payload.completeness = 'partial';
    const files = new MarkdownPlanFiles();
    files.remember('session', [shared], false);
    expect(files.read('session')).toEqual([]);
    shared.payload.steps = [];
    files.remember('session', [plan(project), shared], false);
    expect(files.read('session').every((event) => event.agentId === 'main')).toBe(true);
  });

  it('reads a previously registered file explicitly reused by the agent in a new assignment', () => {
    const project = directory();
    write(join(project, 'PLANO.md'), content(3), 3);
    const candidate = plan(project);
    candidate.ts = at(5);
    candidate.promptId = 'next';
    candidate.dedupeKey = 'new-reference';
    candidate.payload = {
      ...candidate.payload,
      planId: 'markdown:main:next',
      scopeId: 'next',
      completeness: 'partial',
      steps: [],
    };
    const next = {
      ...prompt(project),
      ts: at(4),
      promptId: 'next',
      payload: { promptId: 'next', preview: 'Extend the feature', charCount: 18 },
    };
    const files = new MarkdownPlanFiles();
    files.remember('session', [prompt(project), plan(project), next, candidate], false);
    const events = files.read('session');
    expect(events[0]?.payload.scopeId).toBe('next');
    expect(progress(events[0]!).percent).toBe(75);
  });

  it.each([false, true])(
    'removes a newer full child percentage when shared ownership is discovered (restart=%s)',
    (restart) => {
      const project = directory();
      write(join(project, 'PLANO.md'), content(4), 3);
      const child = plan(project, 'child');
      let files = new MarkdownPlanFiles();
      files.remember('session', [child], false);
      const observed = files.read('session')[0]!;
      expect(progress(observed).percent).toBe(100);
      if (restart) {
        files = new MarkdownPlanFiles();
        files.restore(observed);
      }
      const shared = { ...child, payload: { ...child.payload, completeness: 'partial' as const } };
      files.remember('session', [shared, plan(project)], false);
      const corrected = files.read('session');
      expect(corrected.find((event) => event.agentId === 'child')?.payload.completeness).toBe(
        'partial',
      );
      const projector = new BoardProjector();
      projector.applyAll(
        [child, observed, shared, ...corrected].map((event, index) => ({
          ...event,
          id: index + 1,
          receivedTs: event.ts,
        })) as MiranteEvent[],
      );
      const card = projector.snapshot().sessions[0]?.cards.find((card) => card.agentId === 'child');
      expect(workProgress(card?.plan).percent).toBeUndefined();
      files.remember('session', [shared, plan(project)], false);
      expect(files.read('session')).toEqual([]);
    },
  );

  it('refuses outside paths, symlink escapes and oversized files', () => {
    const project = directory();
    const outside = directory();
    write(join(outside, 'PLANO.md'), content(4), 3);
    symlinkSync(join(outside, 'PLANO.md'), join(project, 'PLANO.md'));
    const files = new MarkdownPlanFiles();
    files.remember('session', [prompt(project), plan(project)], false);
    expect(files.read('session')[0]?.payload.completeness).toBe('partial');
    rmSync(join(project, 'PLANO.md'));
    write(join(project, 'PLANO.md'), content(4) + '\n' + 'x'.repeat(512 * 1024), 3);
    const oversized = new MarkdownPlanFiles();
    oversized.remember('session', [prompt(project), plan(project)], false);
    expect(oversized.read('session')[0]?.payload.completeness).toBe('partial');
    const escaped = plan(project);
    escaped.payload.sourceFile = join(outside, 'PLANO.md');
    const absolute = new MarkdownPlanFiles();
    absolute.remember('session', [prompt(project), escaped], false);
    expect(absolute.read('session')[0]?.payload.completeness).toBe('partial');
  });

  it('captures the last checklist on completion but ignores edits after the assignment ended', () => {
    const project = directory();
    const file = join(project, 'PLANO.md');
    write(file, content(4), 4);
    const ended: DraftEvent = { ...prompt(project), ts: at(5), kind: 'session.ended', payload: {} };
    const files = new MarkdownPlanFiles();
    files.remember('session', [prompt(project), plan(project), ended], false);
    expect(progress(files.read('session')[0]!).percent).toBe(100);
    write(file, content(1), 6);
    expect(files.read('session')).toEqual([]);
    files.remember('session', [prompt(project), plan(project), ended], false);
    expect(files.read('session')).toEqual([]);
  });
});

it('polls a registered file without transcript changes, replays on restart, and keeps activity unchanged', () => {
  const root = directory();
  const project = join(root, 'project');
  const projectsDir = join(root, 'transcripts');
  const slug = join(projectsDir, 'project');
  mkdirSync(project);
  mkdirSync(slug, { recursive: true });
  const file = join(project, 'PLANO.md');
  write(file, content(1), 2);
  const base = { sessionId: 'session', cwd: project };
  const lines = [
    {
      ...base,
      timestamp: at(1),
      type: 'user',
      uuid: 'user',
      promptId: 'request',
      message: { role: 'user', content: 'Implement the feature' },
    },
    {
      ...base,
      timestamp: at(2),
      type: 'assistant',
      uuid: 'assistant',
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
      toolUseResult: { type: 'create', filePath: file, content: content(1), userModified: false },
    },
  ];
  writeFileSync(
    join(slug, 'session.jsonl'),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
  const log = new EventLog(':memory:');
  try {
    const projector = new BoardProjector();
    const options = {
      projectsDir,
      log,
      onEvents: (events: MiranteEvent[]) => projector.applyAll(events),
    };
    const watcher = new TranscriptWatcher(options);
    watcher.scan();
    const main = () =>
      projector.snapshot().sessions[0]?.cards.find((card) => card.agentId === 'main');
    expect(workProgress(main()?.plan).percent).toBe(25);
    const activityAt = main()?.lastEventAt;
    write(file, content(3), 3);
    expect(watcher.scan()).toBe(1);
    expect(workProgress(main()?.plan).percent).toBe(75);
    expect(main()?.lastEventAt).toBe(activityAt);
    expect(watcher.scan()).toBe(0);
    const restarted = new TranscriptWatcher(options);
    restarted.reindexFromLog();
    expect(restarted.scan()).toBe(0);
    write(file, content(4), 4);
    expect(restarted.scan()).toBe(1);
    expect(workProgress(main()?.plan).percent).toBe(100);
  } finally {
    log.close();
  }
});
