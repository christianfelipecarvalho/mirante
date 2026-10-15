import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, miranteEventSchema, type MiranteEvent } from '@mirante/shared';
import { EventLog } from '../../core/eventlog.js';
import { normalizeWorkPlan } from '../../core/work-plan.js';
import { hookToEvents, type HookPayload } from '../hooks.js';
import { parseSessionTranscript } from './parse.js';
import { TranscriptWatcher } from './watcher.js';

const ts = '2026-09-01T09:00:00.000Z';
const doneTs = '2026-09-01T09:00:01.000Z';
const base = { sessionId: 'session', cwd: '/tmp/project', timestamp: ts };
const prompt = (promptId = 'prompt', text = 'Implement the requested feature') => ({
  ...base,
  type: 'user',
  uuid: `user-${promptId}`,
  promptId,
  message: { role: 'user', content: text },
});
const use = (name: string, input: unknown, id = 'call') => ({
  ...base,
  type: 'assistant',
  uuid: `assistant-${id}`,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (output?: unknown, id = 'call', error = false) => ({
  ...base,
  timestamp: doneTs,
  type: 'user',
  uuid: `result-${id}`,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: 'Confirmed' }],
  },
  ...(output === undefined ? {} : { toolUseResult: output }),
});
const todo = (content = 'Review implementation', status = 'pending') => ({
  content,
  status,
  activeForm: 'Reviewing implementation',
});
const plans = (
  mainLines: unknown[],
  subagents?: { agentId: string; meta?: unknown; lines: unknown[] }[],
) =>
  parseSessionTranscript({ mainLines, ...(subagents ? { subagents } : {}) }).events.filter(
    (event) => event.kind === 'task.plan.updated',
  );

describe('work-plan normalization at ingest', () => {
  it('redacts labels before persistence while preserving native statuses and IDs', () => {
    expect(
      normalizeWorkPlan([
        {
          id: 'native-id',
          text: 'Contact person@example.com using sk-ant-secrettoken12345',
          status: 'in_progress',
        },
      ]),
    ).toEqual([
      { id: 'native-id', text: 'Contact [redacted] using [redacted]', status: 'in_progress' },
    ]);
  });

  it.each([
    {},
    [null],
    [{ id: '1', text: 'Known step', status: 'done' }],
    [{ id: '', text: 'Known step', status: 'pending' }],
    [{ id: '1', text: ' ', status: 'pending' }],
    [
      { id: '1', text: 'Known step', status: 'pending' },
      { id: '1', text: 'Other step', status: 'completed' },
    ],
    [{ id: '1', text: 'x'.repeat(4001), status: 'pending' }],
    Array.from({ length: 501 }, (_, index) => ({
      id: String(index),
      text: 'Step',
      status: 'pending',
    })),
  ])('rejects a malformed or oversized whole snapshot (%#)', (input) => {
    expect(normalizeWorkPlan(input)).toBeUndefined();
  });

  it('retains an explicit empty snapshot without manufacturing completed work', () => {
    expect(normalizeWorkPlan([])).toEqual([]);
  });
});

describe('confirmed Claude checklist snapshots', () => {
  it('reattaches a previously confirmed file to a new request only after a paired successful Bash reference', () => {
    const filePath = '/tmp/project/PLANO.md';
    const content = '# Plano\n- [x] Read\n- [ ] Implement';
    const initial = [
      prompt(),
      use('Write', { file_path: filePath, content }),
      result({ filePath, content }),
    ];
    const request = {
      ...prompt('next', 'Implement the next stage'),
      timestamp: '2026-09-01T09:00:02.000Z',
    };
    const bash = {
      ...use('Bash', { command: 'python3 -c \'p="PLANO.md"; print(p)\'' }, 'shell'),
      timestamp: '2026-09-01T09:00:03.000Z',
    };
    const success = {
      ...result({ stdout: '', stderr: '', interrupted: false }, 'shell'),
      timestamp: '2026-09-01T09:00:04.000Z',
    };
    expect(plans([...initial, request, bash])).toHaveLength(1);
    expect(
      plans([...initial, request, bash, { ...success, toolUseResult: { interrupted: true } }]),
    ).toHaveLength(1);
    const events = plans([...initial, request, bash, success]);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      ts: success.timestamp,
      promptId: 'next',
      payload: {
        sourceTool: 'Markdown',
        sourceFile: 'PLANO.md',
        scopeId: 'next',
        completeness: 'partial',
        steps: [],
      },
    });
    expect(events[1]?.payload.planId).not.toBe(events[0]?.payload.planId);
  });

  it.each([false, true])(
    'keeps a shared project checklist partial for children regardless of write order (%s)',
    (childFirst) => {
      const filePath = '/tmp/project/PLANO.md';
      const content = '# Plano\n- [x] Main work\n- [ ] Child work';
      const input = { file_path: filePath, content };
      const output = { filePath, content };
      const first = '2026-09-01T09:00:01.000Z';
      const second = '2026-09-01T09:00:02.000Z';
      const events = plans(
        [
          prompt(),
          use('Write', input, 'main-write'),
          { ...result(output, 'main-write'), timestamp: childFirst ? second : first },
        ],
        [
          {
            agentId: 'child',
            lines: [
              prompt(),
              use('Write', input, 'child-write'),
              { ...result(output, 'child-write'), timestamp: childFirst ? first : second },
            ],
          },
        ],
      );
      expect(events.find((event) => event.agentId === MAIN_AGENT_ID)?.payload.completeness).toBe(
        'full',
      );
      expect(events.find((event) => event.agentId === 'child')?.payload.completeness).toBe(
        'partial',
      );
    },
  );

  it('does not let a failed or unpaired main write contaminate a child-owned checklist', () => {
    const filePath = '/tmp/project/plan.md';
    const content = '# Plan\n- [x] Child work';
    const input = { file_path: filePath, content };
    const output = { filePath, content };
    const events = plans(
      [
        prompt(),
        use('Write', input, 'failed-write'),
        result(output, 'failed-write', true),
        use('Write', input, 'unpaired-write'),
      ],
      [
        {
          agentId: 'child',
          lines: [prompt(), use('Write', input, 'child-write'), result(output, 'child-write')],
        },
      ],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.completeness).toBe('full');
  });

  it('does not merge plans with the same filename in distinct project directories', () => {
    const content = '# Plan\n- [x] Local work';
    const events = plans(
      [
        prompt(),
        use('Write', { file_path: '/tmp/project/plan.md', content }, 'main-write'),
        result({ filePath: '/tmp/project/plan.md', content }, 'main-write'),
      ],
      [
        {
          agentId: 'child',
          lines: [
            { ...prompt(), cwd: '/tmp/other-project' },
            {
              ...use('Write', { file_path: '/tmp/other-project/plan.md', content }, 'child-write'),
              cwd: '/tmp/other-project',
            },
            {
              ...result({ filePath: '/tmp/other-project/plan.md', content }, 'child-write'),
              cwd: '/tmp/other-project',
            },
          ],
        },
      ],
    );
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.payload.completeness === 'full')).toBe(true);
  });

  it('captures a confirmed Markdown plan written with ordinary file tools', () => {
    const filePath = '/tmp/project/PLANO-CANVAS.md';
    const content = '# Plano\n\nProgresso: 90%\n\n- [x] Read\n- [ ] Implement\n- [ ] Verify\n';
    const input = { file_path: filePath, content };
    expect(plans([prompt(), use('Write', input)])).toEqual([]);
    const written = result({ type: 'create', filePath, content, userModified: false });
    const editInput = {
      file_path: filePath,
      old_string: '- [ ] Implement',
      new_string: '- [x] Implement',
    };
    const edited = result(
      {
        filePath,
        originalFile: content,
        oldString: editInput.old_string,
        newString: editInput.new_string,
        replaceAll: false,
        userModified: false,
      },
      'edit',
    );
    edited.timestamp = '2026-09-01T09:00:02.000Z';
    const events = plans([
      prompt(),
      use('Write', input),
      written,
      { ...use('Edit', editInput, 'edit'), timestamp: doneTs },
      edited,
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      agentId: MAIN_AGENT_ID,
      promptId: 'prompt',
      payload: {
        sourceTool: 'Markdown',
        sourceFile: 'PLANO-CANVAS.md',
        scopeId: 'prompt',
        completeness: 'full',
      },
    });
    expect(events[1]?.payload.steps.map((step) => step.status)).toEqual([
      'completed',
      'completed',
      'pending',
    ]);
    expect(events[1]?.payload.planId).toBe(events[0]?.payload.planId);
    expect(
      plans([
        prompt(),
        use('Write', input),
        {
          ...written,
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call', is_error: true, content: 'Failed' },
            ],
          },
        },
      ]),
    ).toEqual([]);
  });

  it('does not borrow a Markdown snapshot from a parallel result or another owner', () => {
    const filePath = '/tmp/project/progress.md';
    const content = '# Progress\n- [x] Read\n- [ ] Implement';
    const confirmation = result({ filePath, content });
    confirmation.message.content.push({
      type: 'tool_result',
      tool_use_id: 'other',
      is_error: false,
      content: 'Confirmed',
    });
    expect(plans([prompt(), use('Write', { file_path: filePath, content }), confirmation])).toEqual(
      [],
    );
    const child = plans(
      [result({ filePath, content })],
      [{ agentId: 'child', lines: [prompt(), use('Write', { file_path: filePath, content })] }],
    );
    expect(child[0]?.agentId).toBe('child');
    expect(child[0]?.payload.sourceTool).toBe('Markdown');
  });

  it('waits for a successful paired TodoWrite result and uses the applied native snapshot', () => {
    const input = { todos: [todo('Proposed step')] };
    expect(plans([prompt(), use('TodoWrite', input)])).toEqual([]);
    const events = plans([
      prompt(),
      use('TodoWrite', input),
      result({ oldTodos: [], newTodos: [todo('Applied step', 'completed')] }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ts: doneTs,
      agentId: MAIN_AGENT_ID,
      promptId: 'prompt',
      correlationId: 'call',
      payload: {
        sourceTool: 'TodoWrite',
        scopeId: 'prompt',
        completeness: 'full',
        steps: [{ id: 'step-1', text: 'Applied step', status: 'completed' }],
      },
    });
    expect(miranteEventSchema.safeParse({ ...events[0], id: 1, receivedTs: doneTs }).success).toBe(
      true,
    );
  });

  it('confirms native input when the paired result has only serialized content', () => {
    expect(
      plans([prompt(), use('TodoWrite', { todos: [todo()] }), result()])[0]?.payload,
    ).toMatchObject({
      completeness: 'full',
      steps: [{ text: 'Review implementation', status: 'pending' }],
    });
  });

  it('prefers the latest result flush over an earlier fallback snapshot of the same call', () => {
    const events = plans([
      prompt(),
      use('TodoWrite', { todos: [todo('Proposed step')] }),
      result(),
      {
        ...result({ newTodos: [todo('Applied step', 'completed')] }),
        timestamp: '2026-09-01T09:00:02.000Z',
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.steps).toEqual([
      { id: 'step-1', text: 'Applied step', status: 'completed' },
    ]);
  });

  it.each([
    result({}, 'call', true),
    result({ success: false }),
    result({ interrupted: true }),
    result({ is_error: true }),
    result({}, 'different-call'),
    { ...result({}), timestamp: 'invalid timestamp' },
    { ...result({}), sessionId: 'another-session' },
    result({ newTodos: [todo('Invalid applied step', 'done')] }),
  ])('does not commit failed, unpaired, malformed, or undated plans (%#)', (confirmation) => {
    expect(plans([prompt(), use('TodoWrite', { todos: [todo()] }), confirmation])).toEqual([]);
  });

  it('rejects every malformed TodoWrite step and preserves a confirmed clearing snapshot', () => {
    expect(plans([prompt(), use('TodoWrite', { todos: [todo(), null] }), result()])).toEqual([]);
    expect(plans([prompt(), use('TodoWrite', { todos: [] }), result()])[0]?.payload).toMatchObject({
      completeness: 'full',
      steps: [],
    });
  });

  it('does not treat the older Task delegation tool as a checklist', () => {
    expect(
      plans([
        prompt(),
        use('Task', { subject: 'Delegate research' }),
        result({ task: { id: '1', subject: 'Research' } }),
      ]),
    ).toEqual([]);
  });

  it('attributes a result to the calling child even when recorded in the main stream', () => {
    const events = plans(
      [result()],
      [{ agentId: 'child', lines: [prompt(), use('TodoWrite', { todos: [todo()] })] }],
    );
    expect(events[0]).toMatchObject({
      agentId: 'child',
      promptId: 'prompt',
      payload: { scopeId: 'prompt' },
    });
  });

  it('does not borrow a structured output from a sibling parallel result', () => {
    const confirmation = result({ task: { id: '1', subject: 'First' } });
    confirmation.message.content.push({
      type: 'tool_result',
      tool_use_id: 'second',
      is_error: false,
      content: 'Confirmed',
    });
    expect(
      plans([
        prompt(),
        use('TaskCreate', { subject: 'First' }),
        use('TaskCreate', { subject: 'Second' }, 'second'),
        confirmation,
      ]),
    ).toEqual([]);
  });
});

describe('native incremental Claude task views', () => {
  const task = (id: string, subject: string, status = 'pending') => ({
    id,
    subject,
    status,
    blockedBy: [],
  });
  const pair = (name: string, input: unknown, output: unknown, id: string, second: number) => [
    {
      ...use(name, input, id),
      timestamp: `2026-09-01T09:00:${String(second).padStart(2, '0')}.000Z`,
    },
    {
      ...result(output, id),
      timestamp: `2026-09-01T09:00:${String(second + 1).padStart(2, '0')}.000Z`,
    },
  ];

  it('keeps creates and updates partial until a native TaskList confirms complete coverage', () => {
    const events = plans([
      prompt(),
      ...pair(
        'TaskCreate',
        { subject: 'First' },
        { task: { id: '7', subject: 'First' } },
        'create',
        2,
      ),
      ...pair(
        'TaskUpdate',
        { taskId: '7', status: 'in_progress' },
        {
          success: true,
          taskId: '7',
          updatedFields: ['status'],
          statusChange: { from: 'pending', to: 'in_progress' },
        },
        'update',
        4,
      ),
      ...pair(
        'TaskList',
        {},
        { tasks: [task('7', 'First', 'in_progress'), task('9', 'Second', 'completed')] },
        'list',
        6,
      ),
      ...pair(
        'TaskUpdate',
        { task_id: '7', status: 'completed' },
        {
          success: true,
          taskId: '7',
          updatedFields: ['status'],
          statusChange: { from: 'in_progress', to: 'completed' },
        },
        'finish',
        8,
      ),
    ]);
    expect(events.map((event) => event.payload.completeness)).toEqual([
      'partial',
      'partial',
      'full',
      'full',
    ]);
    expect(events[3]?.payload.steps).toEqual([
      { id: '7', text: 'First', status: 'completed' },
      { id: '9', text: 'Second', status: 'completed' },
    ]);
    expect(new Set(events.map((event) => event.payload.planId)).size).toBe(1);
  });

  it('retains native TaskList coverage across simple continuations and resets on new substantive assignments', () => {
    const events = plans([
      prompt(),
      ...pair('TaskList', {}, { tasks: [task('7', 'First')] }, 'list', 2),
      { ...prompt('continue', 'continue'), timestamp: '2026-09-01T09:00:04.000Z' },
      ...pair(
        'TaskUpdate',
        { taskId: '7', status: 'completed' },
        { success: true, taskId: '7', updatedFields: ['status'] },
        'finish',
        5,
      ),
      { ...prompt('new', 'Implement another feature'), timestamp: '2026-09-01T09:00:07.000Z' },
      ...pair(
        'TaskCreate',
        { subject: 'New work' },
        { task: { id: '11', subject: 'New work' } },
        'create',
        8,
      ),
    ]);
    expect(events.map((event) => event.payload.completeness)).toEqual(['full', 'full', 'partial']);
    expect(events[1]?.payload.scopeId).toBe('prompt');
    expect(events[1]?.promptId).toBe('continue');
    expect(events[2]?.payload.steps).toEqual([{ id: '11', text: 'New work', status: 'pending' }]);
  });

  it('applies native deletions and subject edits without rewriting other IDs', () => {
    const events = plans([
      prompt(),
      ...pair('TaskList', {}, { tasks: [task('7', 'First'), task('9', 'Second')] }, 'list', 2),
      ...pair(
        'TaskUpdate',
        { id: '7', subject: 'Contact person@example.com' },
        { success: true, taskId: '7', updatedFields: ['subject'] },
        'rename',
        4,
      ),
      ...pair(
        'TaskUpdate',
        { taskId: '9', status: 'deleted' },
        { success: true, taskId: '9', updatedFields: ['status'] },
        'delete',
        6,
      ),
    ]);
    expect(events[2]?.payload).toMatchObject({
      completeness: 'full',
      steps: [{ id: '7', text: 'Contact [redacted]', status: 'pending' }],
    });
  });

  it('never invents a label or status for an isolated TaskUpdate', () => {
    expect(
      plans([
        prompt(),
        ...pair(
          'TaskUpdate',
          { taskId: '7', status: 'completed' },
          { success: true, taskId: '7', updatedFields: ['status'] },
          'unknown',
          2,
        ),
      ]),
    ).toEqual([]);
    expect(
      plans([
        prompt(),
        ...pair(
          'TaskUpdate',
          { taskId: '7', subject: 'Known label' },
          { success: true, taskId: '7', updatedFields: ['subject'] },
          'unknown',
          2,
        ),
      ]),
    ).toEqual([]);
  });

  it('rejects malformed reads and failures, and marks contradictory successful writes as partial', () => {
    expect(
      plans([
        prompt(),
        ...pair(
          'TaskList',
          {},
          { tasks: [task('7', 'First'), task('8', 'Second', 'unknown')] },
          'list',
          2,
        ),
      ]),
    ).toEqual([]);
    const events = plans([
      prompt(),
      ...pair('TaskList', {}, { tasks: [task('7', 'First')] }, 'list', 2),
      ...pair(
        'TaskUpdate',
        { taskId: '7', status: 'completed' },
        { success: false, taskId: '7', updatedFields: ['status'] },
        'failed',
        4,
      ),
      ...pair(
        'TaskUpdate',
        { taskId: 'other', status: 'completed' },
        { success: true, taskId: '7', updatedFields: ['status'] },
        'mismatch',
        6,
      ),
    ]);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      ts: '2026-09-01T09:00:07.000Z',
      agentId: MAIN_AGENT_ID,
      correlationId: 'mismatch',
      payload: {
        completeness: 'partial',
        scopeId: 'prompt',
        steps: [{ id: '7', text: 'First', status: 'pending' }],
      },
    });
  });
});

describe('Claude assignment identity', () => {
  it('uses native spawning call IDs and keeps a late old confirmation in the old assignment', () => {
    const at = (
      entry: ReturnType<typeof use> | ReturnType<typeof result> | ReturnType<typeof prompt>,
      second: number,
    ) => ({
      ...entry,
      timestamp: `2026-09-01T09:00:${String(second).padStart(2, '0')}.000Z`,
    });
    const parsed = parseSessionTranscript({
      mainLines: [
        prompt(),
        at(use('Agent', { prompt: 'First assignment' }, 'spawn'), 1),
        at(result({ agentId: 'child', status: 'completed' }, 'spawn'), 8),
        at(use('Agent', { resume: 'child', prompt: 'Second assignment' }, 'resume'), 10),
        at(result({ agentId: 'child', status: 'completed' }, 'resume'), 20),
      ],
      subagents: [
        {
          agentId: 'child',
          meta: { toolUseId: 'spawn' },
          lines: [
            at(prompt(), 2),
            at(use('TodoWrite', { todos: [todo('First plan')] }, 'first-plan'), 3),
            at(result(undefined, 'first-plan'), 4),
            at(use('TodoWrite', { todos: [todo('Delayed old plan')] }, 'late-plan'), 5),
            {
              ...at(prompt('next', 'Second assignment'), 11),
              sourceToolAssistantUUID: 'assistant-resume',
            },
            at(result(undefined, 'late-plan'), 12),
            at(use('TodoWrite', { todos: [todo('Second plan')] }, 'next-plan'), 13),
            at(result(undefined, 'next-plan'), 14),
          ],
        },
      ],
    });
    const starts = parsed.events.filter((event) => event.kind === 'agent.started');
    expect(starts.map((event) => event.payload.assignmentId)).toEqual(['spawn', 'resume']);
    const planEvents = parsed.events.filter((event) => event.kind === 'task.plan.updated');
    expect(planEvents.map((event) => event.payload.scopeId)).toEqual(['spawn', 'spawn', 'resume']);
    expect(planEvents[0]?.ts).toBe('2026-09-01T09:00:04.000Z');
    expect((planEvents[0]?.ts ?? '') < (starts[0]?.ts ?? '')).toBe(true);
  });
});

describe('confirmed Claude hook plans', () => {
  const hook = (hook_event_name: string, tool_name = 'TodoWrite'): HookPayload => ({
    hook_event_name,
    session_id: 'session',
    cwd: '/tmp/project',
    agent_id: 'child',
    prompt_id: 'prompt',
    tool_use_id: 'call',
    tool_name,
    tool_input: { todos: [todo('Email person@example.com')] },
    tool_response: { newTodos: [todo('Email person@example.com')] },
  });
  it.each(['PreToolUse', 'PostToolUseFailure'])(
    'does not record proposed or failed plans from %s',
    (name) => {
      expect(
        hookToEvents(hook(name), { now: doneTs }).some(
          (event) => event.kind === 'task.plan.updated',
        ),
      ).toBe(false);
    },
  );
  it('records a PostToolUse TodoWrite under its real owner, redacted and correlated with replay', () => {
    const events = hookToEvents(hook('PostToolUse'), { now: doneTs });
    const event = events.find((event) => event.kind === 'task.plan.updated');
    expect(event).toMatchObject({
      ts: doneTs,
      agentId: 'child',
      promptId: 'prompt',
      correlationId: 'call',
      payload: { completeness: 'full', scopeId: 'prompt', steps: [{ text: 'Email [redacted]' }] },
    });
    expect(event?.dedupeKey).toBe(
      plans(
        [],
        [
          {
            agentId: 'child',
            lines: [
              prompt(),
              use('TodoWrite', { todos: [todo('Email person@example.com')] }),
              result(),
            ],
          },
        ],
      )[0]?.dedupeKey,
    );
  });
  it('ignores a contradictory failure output even on a success hook', () => {
    expect(
      hookToEvents(
        { ...hook('PostToolUse'), tool_response: { success: false } },
        { now: doneTs },
      ).some((event) => event.kind === 'task.plan.updated'),
    ).toBe(false);
  });
  it('records a TaskCreate hook as partial coverage', () => {
    const events = hookToEvents(
      {
        ...hook('PostToolUse', 'TaskCreate'),
        tool_input: { subject: 'New task' },
        tool_response: { task: { id: '42', subject: 'New task' } },
      },
      { now: doneTs },
    );
    expect(events.find((event) => event.kind === 'task.plan.updated')?.payload).toMatchObject({
      sourceTool: 'TaskCreate',
      completeness: 'partial',
      steps: [{ id: '42', text: 'New task', status: 'pending' }],
    });
  });
});

const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Claude checklist replay and backfill', () => {
  it('recovers partial and complete plans only for known old sessions, without historical starts or restart duplicates', () => {
    const folder = mkdtempSync(join(tmpdir(), 'mirante-work-plan-'));
    folders.push(folder);
    const project = join(folder, 'project');
    mkdirSync(project);
    const records = [
      prompt(),
      use('TaskCreate', { subject: 'Observed task' }, 'create'),
      result({ task: { id: '4', subject: 'Observed task' } }, 'create'),
      { ...use('TaskList', {}, 'list'), timestamp: '2026-09-01T09:00:02.000Z' },
      {
        ...result(
          { tasks: [{ id: '4', subject: 'Observed task', status: 'completed', blockedBy: [] }] },
          'list',
        ),
        timestamp: '2026-09-01T09:00:03.000Z',
      },
    ];
    for (const sessionId of ['known', 'unknown']) {
      const path = join(project, `${sessionId}.jsonl`);
      writeFileSync(
        path,
        records.map((record) => JSON.stringify({ ...record, sessionId })).join('\n') + '\n',
      );
      utimesSync(path, new Date(0), new Date(0));
    }
    const log = new EventLog(join(folder, 'events.db'));
    try {
      log.append({
        ts,
        source: 'hook',
        sessionId: 'known',
        projectPath: '/tmp/project',
        agentId: MAIN_AGENT_ID,
        kind: 'session.ended',
        payload: {},
      });
      const received: MiranteEvent[] = [];
      const watcher = new TranscriptWatcher({
        projectsDir: folder,
        log,
        knownSessionIds: new Set(['known']),
        onEvents: (events) => received.push(...events),
      });
      watcher.reindexFromLog();
      expect(watcher.scan()).toBe(2);
      expect(received.map((event) => event.kind)).toEqual([
        'task.plan.updated',
        'task.plan.updated',
      ]);
      expect(received.every((event) => event.sessionId === 'known')).toBe(true);
      expect(
        received.map((event) => event.kind === 'task.plan.updated' && event.payload.completeness),
      ).toEqual(['partial', 'full']);
      expect(watcher.scan()).toBe(0);
      const restarted = new TranscriptWatcher({
        projectsDir: folder,
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

  it('enriches an already-recorded old finish with its response without importing an unseen finish', () => {
    const folder = mkdtempSync(join(tmpdir(), 'mirante-result-backfill-'));
    folders.push(folder);
    const project = join(folder, 'project');
    mkdirSync(project);
    const main = join(project, 'known.jsonl');
    writeFileSync(main, JSON.stringify({ ...prompt(), sessionId: 'known' }) + '\n');
    utimesSync(main, new Date(0), new Date(0));
    const subagents = join(project, 'known', 'subagents');
    mkdirSync(subagents, { recursive: true });
    for (const agentId of ['child', 'unseen']) {
      const path = join(subagents, `agent-${agentId}.jsonl`);
      writeFileSync(
        path,
        JSON.stringify({
          ...base,
          sessionId: 'known',
          timestamp: doneTs,
          type: 'assistant',
          message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Final answer. Contact person@example.com.' }],
          },
        }) + '\n',
      );
      utimesSync(path, new Date(0), new Date(0));
    }
    const log = new EventLog(join(folder, 'events.db'));
    try {
      log.append({
        ts,
        source: 'hook',
        sessionId: 'known',
        projectPath: '/tmp/project',
        agentId: 'child',
        kind: 'agent.finished',
        dedupeKey: 'agent.finished:child',
        payload: { outcome: 'ok' },
      });
      const received: MiranteEvent[] = [];
      const watcher = new TranscriptWatcher({
        projectsDir: folder,
        log,
        knownSessionIds: new Set(['known']),
        onEvents: (events) => received.push(...events),
      });
      watcher.reindexFromLog();
      expect(watcher.scan()).toBe(1);
      expect(received[0]).toMatchObject({
        kind: 'agent.finished',
        agentId: 'child',
        payload: {
          resultAvailability: 'captured',
          resultPreview: 'Final answer. Contact [redacted].',
        },
      });
      expect(watcher.scan()).toBe(0);
      const restarted = new TranscriptWatcher({
        projectsDir: folder,
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
