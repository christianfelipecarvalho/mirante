import { describe, expect, it } from 'vitest';
import { groupStepsByTurn, type Step } from './steps.js';

let id = 0;
const step = (partial: Partial<Step> & Pick<Step, 'ts'>): Step => ({
  id: (id += 1),
  kind: 'tool',
  title: 'Bash',
  status: 'ok',
  agentId: 'main',
  ...partial,
});

describe('groupStepsByTurn', () => {
  const steps = [
    step({
      ts: '2026-09-21T10:00:00Z',
      kind: 'prompt',
      title: 'prompt',
      detail: 'fix the build',
      promptId: 'p1',
    }),
    step({ ts: '2026-09-21T10:00:05Z', promptId: 'p1' }),
    step({ ts: '2026-09-21T10:00:09Z', promptId: 'p1', status: 'failed' }),
    step({
      ts: '2026-09-21T10:05:00Z',
      kind: 'prompt',
      title: 'prompt',
      detail: '.',
      promptId: 'p2',
    }),
    step({
      ts: '2026-09-21T10:05:02Z',
      promptId: 'p2',
      agentId: 'a1',
      kind: 'prompt',
      title: 'prompt',
      detail: 'brief',
    }),
  ];

  it('puts the newest request first, with its steps newest first', () => {
    const groups = groupStepsByTurn(steps);
    expect(groups.map((g) => g.prompt)).toEqual(['.', 'fix the build']);
    const first = groups[1]?.steps.map((s) => s.ts);
    expect(first).toEqual(['2026-09-21T10:00:09Z', '2026-09-21T10:00:05Z']);
  });

  it("makes the person's prompt the header rather than a row, and keeps a subagent's brief", () => {
    const [latest] = groupStepsByTurn(steps);
    expect(latest?.steps).toHaveLength(1);
    expect(latest?.steps[0]?.agentId).toBe('a1');
  });

  it('counts the failures in a turn', () => {
    expect(groupStepsByTurn(steps)[1]?.failed).toBe(1);
  });

  it('shows the request, not the note about which file was open', () => {
    const [group] = groupStepsByTurn([
      step({
        ts: '2026-09-21T10:00:00Z',
        kind: 'prompt',
        detail: '<ide_opened_file>The user opened /w/.env</ide_opened_file> ship it',
        promptId: 'p1',
      }),
    ]);
    expect(group?.prompt).toBe('ship it');
  });

  it('gathers steps no request could be tied to under one header', () => {
    const [group] = groupStepsByTurn([step({ ts: '2026-09-21T10:00:00Z' })]);
    expect(group?.promptId).toBe('—');
    expect(group?.prompt).toBeUndefined();
  });

  /** Not "text not captured": nothing was lost, a subagent opened the turn. */
  it('says a turn was opened by a subagent reporting back', () => {
    const [group] = groupStepsByTurn([
      step({
        ts: '2026-09-21T10:00:00Z',
        kind: 'prompt',
        detail: '<agent-message from="a1"> [Subagent hand-back] …',
        promptId: 'p9',
        injected: true,
      }),
      step({ ts: '2026-09-21T10:00:04Z', promptId: 'p9' }),
    ]);
    expect(group?.prompt).toBeUndefined();
    expect(group?.origin).toBe('agent');
    expect(group?.steps).toHaveLength(1);
  });
});
