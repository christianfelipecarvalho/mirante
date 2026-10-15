import { describe, expect, it } from 'vitest';
import { dedupeKeys } from './dedupe.js';
import { safeParseMiranteEvent, type MiranteEvent } from './event.js';
import { BoardProjector } from './projector.js';
import { isTaskContinuation, taskPlanPayload, workProgress, type WorkPlan } from './work-plan.js';

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 11, 12, 0, seconds)).toISOString();
const plan = (done = 1, total = 3): WorkPlan => ({
  planId: 'work',
  sourceTool: 'update_plan',
  completeness: 'full',
  updatedAt: at(2),
  steps: Array.from({ length: total }, (_, i) => ({
    id: String(i),
    text: `Etapa ${i + 1}`,
    status: i < done ? 'completed' : 'pending',
  })),
});
let id = 0;
const event = (
  kind: MiranteEvent['kind'],
  ts: number,
  payload: unknown,
  extra = {},
): MiranteEvent =>
  ({
    id: ++id,
    ts: at(ts),
    receivedTs: at(100 + id),
    source: 'transcript',
    sessionId: 's',
    projectPath: '/tmp/p',
    agentId: 'main',
    kind,
    payload,
    ...extra,
  }) as MiranteEvent;
const prompt = (ts: number, preview = 'Implementar progresso', promptId = `request-${ts}`) =>
  event('prompt.submitted', ts, { preview, charCount: preview.length }, { promptId });
const update = (ts: number, p = plan(), extra = {}) => {
  const { updatedAt: _updatedAt, ...payload } = p;
  return event('task.plan.updated', ts, payload, extra);
};
const root = (projector: BoardProjector) =>
  projector.snapshot(Date.parse(at(100))).sessions[0]?.cards.find((c) => c.agentId === 'main');

describe('recorded work progress', () => {
  it('counts completed steps equally and reserves 100 for a complete plan', () => {
    expect(workProgress(plan(0)).percent).toBe(0);
    expect(workProgress(plan(1)).percent).toBe(33);
    expect(workProgress(plan(2)).percent).toBe(66);
    expect(workProgress(plan(3)).percent).toBe(100);
    const p = plan(1);
    p.steps[1]!.status = 'in_progress';
    expect(workProgress(p)).toEqual({
      total: 3,
      completed: 1,
      inProgress: 1,
      pending: 1,
      percent: 33,
    });
    expect(workProgress(plan(499, 500)).percent).toBe(99);
  });
  it('does not give missing, partial or empty checklists a percentage', () => {
    expect(workProgress().percent).toBeUndefined();
    expect(workProgress(plan(0, 0)).percent).toBeUndefined();
    expect(workProgress({ ...plan(3), completeness: 'partial' }).percent).toBeUndefined();
  });
  it('allows recorded scope changes and reopened steps to decrease progress', () => {
    expect(workProgress(plan(3, 3)).percent).toBe(100);
    expect(workProgress(plan(3, 4)).percent).toBe(75);
    expect(workProgress(plan(2, 4)).percent).toBe(50);
  });
  it('validates the new event and rejects duplicate step identifiers', () => {
    expect(safeParseMiranteEvent(update(2)).success).toBe(true);
    const p = plan();
    p.steps[1]!.id = p.steps[0]!.id;
    expect(taskPlanPayload.safeParse(p).success).toBe(false);
  });
  it('preserves the existing closed list of continuation replies', () => {
    for (const text of ['sim', 'Pode continuar!', '.', 'Go ahead'])
      expect(isTaskContinuation(text)).toBe(true);
    for (const text of ['fix the build', 'Ajuste o tema', '', 'sim, e implemente algo novo'])
      expect(isTaskContinuation(text)).toBe(false);
  });
});

describe('assignment-scoped plan projection', () => {
  it('replaces snapshots, dedupes paired sources and ignores older updates', () => {
    const projector = new BoardProjector();
    const key = dedupeKeys.taskPlan('call', 'main');
    projector.applyAll([
      prompt(1),
      update(2, plan(), { source: 'hook', dedupeKey: key }),
      update(2, plan(2), { dedupeKey: key }),
      update(3, plan(3)),
      update(2, plan()),
    ]);
    expect(workProgress(root(projector)?.plan).percent).toBe(100);
    expect(root(projector)?.plan?.steps).toHaveLength(3);
  });
  it('keeps parent and child progress independent', () => {
    const projector = new BoardProjector();
    projector.applyAll([
      prompt(1),
      event(
        'agent.started',
        2,
        { agentType: 'qa', spawnMode: 'async' },
        { agentId: 'child', parentAgentId: 'main' },
      ),
      update(3, plan(1)),
      update(4, plan(3), { agentId: 'child' }),
    ]);
    expect(workProgress(root(projector)?.plan).percent).toBe(33);
    expect(
      workProgress(projector.snapshot().sessions[0]?.cards.find((c) => c.agentId === 'child')?.plan)
        .percent,
    ).toBe(100);
  });
  it('retains progress on interruption and session close without inventing completion or activity', () => {
    const projector = new BoardProjector();
    projector.applyAll([
      prompt(1),
      update(2),
      event('agent.finished', 3, { outcome: 'interrupted' }),
      event('session.ended', 4, { reason: 'other' }),
      update(5, plan(2)),
    ]);
    expect(workProgress(root(projector)?.plan).percent).toBe(66);
    expect(root(projector)?.outcome).toBe('interrupted');
    expect(root(projector)?.endedAt).toBe(at(3));
    expect(root(projector)?.lastEventAt).toBe(at(4));
    expect(projector.snapshot().sessions[0]?.endedAt).toBe(at(4));
  });
  it('resets for a new substantive prompt and excludes old plans even when their confirmation arrived late', () => {
    const projector = new BoardProjector();
    projector.applyAll([
      prompt(1),
      update(2, { ...plan(3), scopeId: 'request-1' }),
      prompt(3, 'Corrija os ícones'),
      update(4, { ...plan(3), scopeId: 'request-1' }),
    ]);
    expect(root(projector)?.plan).toBeUndefined();
    projector.apply(update(5, { ...plan(0), scopeId: 'request-3' }));
    expect(workProgress(root(projector)?.plan).percent).toBe(0);
  });
  it('preserves plans across acknowledgements and enrichment of the same native prompt', () => {
    const projector = new BoardProjector();
    projector.applyAll([prompt(1), update(2), prompt(3, 'sim'), prompt(1)]);
    expect(workProgress(root(projector)?.plan).percent).toBe(33);
  });
  it('keeps the real request scope across remote-session hand-backs recorded by hooks', () => {
    const projector = new BoardProjector();
    const handback = prompt(
      3,
      'Another Claude session sent a message:\n<agent-message from="reviewer">\n[Subagent hand-back] Review completed.',
    );
    projector.applyAll([
      prompt(1),
      update(2, { ...plan(1), scopeId: 'request-1' }),
      { ...handback, source: 'hook' },
    ]);
    expect(workProgress(root(projector)?.plan).percent).toBe(33);

    projector.apply(update(4, { ...plan(2), scopeId: 'request-1' }));
    expect(workProgress(root(projector)?.plan).percent).toBe(66);

    projector.applyAll([
      prompt(5, 'Agora implemente uma nova tarefa'),
      update(6, { ...plan(3), scopeId: 'request-1' }),
    ]);
    expect(root(projector)?.plan).toBeUndefined();
  });
  it('rejects a historical old assignment snapshot and does not reset on a start reread', () => {
    const projector = new BoardProjector();
    const started = event(
      'agent.started',
      1,
      { agentType: 'qa', spawnMode: 'async' },
      { agentId: 'child', dedupeKey: dedupeKeys.agentStarted('child') },
    );
    projector.applyAll([
      started,
      update(2, plan(3), { agentId: 'child' }),
      { ...started, id: ++id },
      event(
        'agent.started',
        3,
        { agentType: 'qa', spawnMode: 'async', followUp: true },
        { agentId: 'child', dedupeKey: dedupeKeys.agentFollowUp('child', 'new') },
      ),
      update(2, plan(3), { agentId: 'child' }),
    ]);
    expect(
      projector.snapshot().sessions[0]?.cards.find((c) => c.agentId === 'child')?.plan,
    ).toBeUndefined();
  });
  it('recovers a confirmed child plan flushed before its new assignment becomes known', () => {
    const projector = new BoardProjector();
    projector.applyAll([
      event(
        'agent.started',
        1,
        { agentType: 'qa', spawnMode: 'async', assignmentId: 'old' },
        { agentId: 'child', dedupeKey: 'initial' },
      ),
      update(
        3,
        { ...plan(1), scopeId: 'new' },
        { agentId: 'child', dedupeKey: dedupeKeys.taskPlan('new-plan', 'child') },
      ),
      event(
        'agent.started',
        4,
        { agentType: 'qa', spawnMode: 'async', followUp: true, assignmentId: 'new' },
        { agentId: 'child', dedupeKey: 'next' },
      ),
    ]);
    expect(
      workProgress(projector.snapshot().sessions[0]?.cards.find((c) => c.agentId === 'child')?.plan)
        .percent,
    ).toBe(33);
  });
  it('enriches an old finish with its recorded response without closing a newer assignment', () => {
    const projector = new BoardProjector();
    const key = dedupeKeys.agentFinished('child');
    projector.applyAll([
      event(
        'agent.started',
        1,
        { agentType: 'qa', spawnMode: 'async', assignmentId: 'old' },
        { agentId: 'child' },
      ),
      event(
        'agent.finished',
        2,
        { outcome: 'ok', assignmentId: 'old' },
        { agentId: 'child', dedupeKey: key },
      ),
      event(
        'agent.finished',
        2,
        { outcome: 'ok', assignmentId: 'old', resultPreview: 'Resultado registrado' },
        { agentId: 'child', dedupeKey: key },
      ),
    ]);
    expect(
      projector.snapshot().sessions[0]?.cards.find((c) => c.agentId === 'child')?.resultPreview,
    ).toBe('Resultado registrado');
    projector.applyAll([
      event(
        'agent.started',
        3,
        { agentType: 'qa', spawnMode: 'async', followUp: true, assignmentId: 'new' },
        { agentId: 'child', dedupeKey: 'followup' },
      ),
      event(
        'agent.finished',
        4,
        { outcome: 'ok', assignmentId: 'old', resultPreview: 'Resposta atrasada' },
        { agentId: 'child', dedupeKey: key },
      ),
    ]);
    const child = projector.snapshot().sessions[0]?.cards.find((c) => c.agentId === 'child');
    expect(child?.endedAt).toBeUndefined();
    expect(child?.resultPreview).toBeUndefined();
    expect(child?.status.state).toBe('thinking');
  });
  it('counts one active child across reassignment and ignores re-read finishes after resumed work', () => {
    const projector = new BoardProjector();
    const key = dedupeKeys.agentFinished('child');
    projector.applyAll([
      prompt(1),
      event(
        'agent.started',
        2,
        { agentType: 'qa', spawnMode: 'async' },
        { agentId: 'child', parentAgentId: 'main', dedupeKey: 'start' },
      ),
      event(
        'agent.started',
        3,
        { agentType: 'qa', spawnMode: 'async', followUp: true },
        { agentId: 'child', parentAgentId: 'main', dedupeKey: 'followup' },
      ),
    ]);
    expect(root(projector)?.runningChildren).toBe(1);
    projector.applyAll([
      event(
        'agent.finished',
        4,
        { outcome: 'ok' },
        { agentId: 'child', parentAgentId: 'main', dedupeKey: key },
      ),
      event(
        'tool.started',
        5,
        { toolUseId: 'resumed', toolName: 'Read', summary: 'Resumed work' },
        { agentId: 'child' },
      ),
      event(
        'agent.finished',
        4,
        { outcome: 'ok', resultPreview: 'Historical return' },
        { agentId: 'child', dedupeKey: key },
      ),
    ]);
    expect(
      projector.snapshot().sessions[0]?.cards.find((c) => c.agentId === 'child')?.status.state,
    ).toBe('tool_running');
  });
});
