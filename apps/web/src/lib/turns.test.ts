import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type MiranteEvent } from '@mirante/shared';
import { buildTurns, latestTurn } from './turns.js';
import { buildSteps } from './steps.js';

let nextId = 0;
const ev = (
  partial: Partial<MiranteEvent> & Pick<MiranteEvent, 'kind' | 'payload'>,
): MiranteEvent =>
  ({
    id: (nextId += 1),
    ts: new Date(Date.UTC(2026, 8, 20, 12, 0, nextId)).toISOString(),
    receivedTs: new Date(Date.UTC(2026, 8, 20, 12, 0, nextId)).toISOString(),
    source: 'transcript',
    sessionId: 'sess-1',
    projectPath: '/home/user/project',
    agentId: MAIN_AGENT_ID,
    ...partial,
  }) as MiranteEvent;

const tokens = (output: number) => ({ input: 1, output, cacheCreation: 0, cacheRead: 0 });

const conversation = (): MiranteEvent[] => [
  ev({
    kind: 'prompt.submitted',
    promptId: 'p1',
    payload: { preview: 'review the export', charCount: 17 },
  }),
  ev({ kind: 'usage.updated', promptId: 'p1', payload: { scope: 'agent', tokens: tokens(100) } }),
  ev({
    kind: 'agent.started',
    promptId: 'p1',
    agentId: 'a1',
    parentAgentId: MAIN_AGENT_ID,
    payload: { agentType: 'review-frontend', spawnMode: 'async' },
  }),
  ev({
    kind: 'agent.started',
    promptId: 'p1',
    agentId: 'a2',
    parentAgentId: MAIN_AGENT_ID,
    payload: { agentType: 'review-backend', spawnMode: 'async' },
  }),
  ev({
    kind: 'tool.started',
    promptId: 'p1',
    agentId: 'a1',
    payload: { toolUseId: 't1', toolName: 'Grep', summary: 'export' },
  }),
  ev({
    kind: 'tool.finished',
    promptId: 'p1',
    agentId: 'a1',
    payload: { toolUseId: 't1', toolName: 'Grep' },
  }),
  ev({
    kind: 'usage.updated',
    promptId: 'p1',
    agentId: 'a1',
    payload: { scope: 'agent', tokens: tokens(50) },
  }),
  ev({
    kind: 'plan.usage.updated',
    promptId: 'p1',
    source: 'statusline',
    payload: { usage: { fiveHour: { usedPercentage: 31 } } },
  }),
  ev({
    kind: 'prompt.submitted',
    promptId: 'p2',
    payload: { preview: 'now ship it', charCount: 11 },
  }),
];

describe('grouping a session into requests', () => {
  const turns = buildTurns(conversation(), 'sess-1');

  it('makes one entry per request, newest first', () => {
    expect(turns.map((turn) => turn.prompt)).toEqual(['now ship it', 'review the export']);
  });

  it('counts the agents a request set in motion, and names them', () => {
    const first = turns.find((turn) => turn.promptId === 'p1');
    expect(first?.agentsSpawned).toBe(2);
    expect(first?.agentTypes.sort()).toEqual(['review-backend', 'review-frontend']);
  });

  it('adds up what the request cost across every agent it spawned', () => {
    // The point of costing a request is that a subagent's spend belongs to the
    // person who asked, not to the subagent.
    expect(turns.find((turn) => turn.promptId === 'p1')?.tokens.output).toBe(150);
  });

  it('records the plan usage reported during the request', () => {
    expect(turns.find((turn) => turn.promptId === 'p1')?.planUsage?.fiveHour?.usedPercentage).toBe(
      31,
    );
  });

  it('treats only the newest request as still open', () => {
    expect(turns.map((turn) => turn.open)).toEqual([true, false]);
  });

  it('keeps events from a version that reported no turn rather than dropping them', () => {
    const orphan = buildTurns(
      [ev({ kind: 'skill.invoked', payload: { skillName: 'review' } })],
      'sess-1',
    );
    expect(orphan).toHaveLength(1);
    expect(orphan[0]?.eventCount).toBe(1);
  });

  it('finds the most recent request across the board', () => {
    expect(latestTurn(conversation())?.turn.prompt).toBe('now ship it');
  });
});

describe('turning the stream into readable steps', () => {
  it('folds a tool start and finish into one line with an outcome', () => {
    const steps = buildSteps(conversation(), { sessionId: 'sess-1', agentId: 'a1' });
    const tool = steps.filter((step) => step.kind === 'tool');
    expect(tool).toHaveLength(1);
    expect(tool[0]).toMatchObject({ title: 'Grep', detail: 'export', status: 'ok' });
    expect(tool[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('leaves a tool that never returned marked as running', () => {
    const steps = buildSteps(
      [
        ev({
          kind: 'tool.started',
          payload: { toolUseId: 't9', toolName: 'Bash', summary: 'sleep' },
        }),
      ],
      { sessionId: 'sess-1' },
    );
    expect(steps[0]?.status).toBe('running');
  });

  it('marks a failed tool with its error, not with its argument', () => {
    const steps = buildSteps(
      [
        ev({
          kind: 'tool.started',
          payload: { toolUseId: 't8', toolName: 'Bash', summary: 'pnpm build' },
        }),
        ev({
          kind: 'tool.failed',
          payload: { toolUseId: 't8', toolName: 'Bash', errorPreview: 'exit 1' },
        }),
      ],
      { sessionId: 'sess-1' },
    );
    expect(steps[0]).toMatchObject({ status: 'failed', detail: 'exit 1' });
  });

  it('can narrow to a single agent', () => {
    const all = buildSteps(conversation(), { sessionId: 'sess-1' });
    const one = buildSteps(conversation(), { sessionId: 'sess-1', agentId: 'a1' });
    expect(one.length).toBeLessThan(all.length);
    expect(one.every((step) => step.agentId === 'a1')).toBe(true);
  });
});
