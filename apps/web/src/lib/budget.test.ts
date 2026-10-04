import { describe, expect, it } from 'vitest';
import { emptyBoard, emptyTokenUsage, type AgentCard, type BoardState } from '@mirante/shared';
import { assessBudget, budgetAssessments, budgetCheckpoint } from './budget.js';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const AT = new Date(NOW).toISOString();
const card = (agentId: string, state: AgentCard['status']['state'] = 'thinking'): AgentCard => ({
  agentId,
  sessionId: 'session',
  status: { state } as AgentCard['status'],
  tokens: emptyTokenUsage(),
  startedAt: AT,
  lastEventAt: AT,
  runningChildren: 0,
});
const board = (): BoardState => ({
  ...emptyBoard(),
  planUsage: { fiveHour: { usedPercentage: 85 } },
  planUsageUpdatedAt: AT,
  sessions: [
    {
      sessionId: 'session',
      projectPath: '/project',
      projectName: 'project',
      entrypoint: 'cli',
      harness: 'claude-code',
      tokens: emptyTokenUsage(),
      startedAt: AT,
      cards: [card('main'), card('child')],
    },
  ],
});

describe('preventive allowance alerts', () => {
  it.each([
    [79.9, 'ok'],
    [80, 'warning'],
    [89.9, 'warning'],
    [90, 'critical'],
    [100, 'exhausted'],
    [105, 'exhausted'],
  ] as const)('uses advisory margins at %s%%', (usedPercentage, level) => {
    const result = assessBudget('codex', { fiveHour: { usedPercentage } }, AT, NOW);
    expect(result.level).toBe(level);
    expect(result.remainingPercentage).toBe(Math.max(0, 100 - usedPercentage));
  });

  it('uses the tightest account window instead of adding percentages', () => {
    expect(
      assessBudget(
        'codex',
        {
          fiveHour: { usedPercentage: 30 },
          sevenDay: { usedPercentage: 95 },
          spendLimit: { usedPercentage: 50 },
        },
        AT,
        NOW,
      ),
    ).toMatchObject({ window: 'sevenDay', level: 'critical', remainingPercentage: 5 });
    expect(budgetAssessments(board(), NOW)).toHaveLength(1);
    expect(budgetAssessments(board(), NOW)[0]?.usedPercentage).toBe(85);
  });

  it('refuses absent, old, invalid and future readings', () => {
    const usage = { fiveHour: { usedPercentage: 100 } };
    for (const updatedAt of [
      undefined,
      'invalid',
      new Date(NOW + 1).toISOString(),
      new Date(NOW - 300_001).toISOString(),
    ]) {
      expect(assessBudget('codex', usage, updatedAt, NOW).level).toBe('unknown');
    }
    expect(assessBudget('codex', usage, new Date(NOW - 300_000).toISOString(), NOW).level).toBe(
      'exhausted',
    );
    expect(assessBudget('codex', undefined, AT, NOW).level).toBe('unknown');
  });

  it('ignores a reset window while retaining another valid window', () => {
    const fiveHour = { usedPercentage: 100, resetsAt: NOW / 1000 };
    expect(assessBudget('codex', { fiveHour }, AT, NOW)).toMatchObject({
      level: 'unknown',
      reason: 'reset',
    });
    expect(
      assessBudget('codex', { fiveHour, sevenDay: { usedPercentage: 85 } }, AT, NOW),
    ).toMatchObject({ level: 'warning', window: 'sevenDay' });
  });

  it('keeps provider allowances separate and excludes ended and silent work', () => {
    const state = board();
    state.sessions[0]!.harness = 'codex';
    state.harnessPlans = { codex: { usage: { fiveHour: { usedPercentage: 20 } }, updatedAt: AT } };
    expect(budgetAssessments(state, NOW)).toMatchObject([{ harness: 'codex', level: 'ok' }]);
    expect(budgetAssessments(state, NOW + 31 * 60_000)).toEqual([]);
    state.sessions[0]!.endedAt = AT;
    expect(budgetAssessments(state, NOW)).toEqual([]);
  });

  it('still shows exhausted-allowance advice when quota overlays obscure activity', () => {
    const state = board();
    state.planUsage = { fiveHour: { usedPercentage: 100 } };
    for (const agent of state.sessions[0]!.cards)
      agent.status = {
        state: 'rate_limited',
        waitingOn: { reason: 'plan_limit', summary: 'At limit', since: AT },
      };
    expect(budgetAssessments(state, NOW)).toMatchObject([
      { level: 'exhausted', remainingPercentage: 0 },
    ]);
  });
});

describe('recovery export', () => {
  it('records observations without claiming task completion or execution control', () => {
    const state = board();
    state.sessions[0]!.cards = [
      card('main', 'idle'),
      {
        ...card('child', 'done'),
        task: 'Check the build',
        brief: 'Review the frontend build',
        parentAgentId: 'main',
      },
      card('failed', 'error'),
    ];
    const checkpoint = budgetCheckpoint(state, 'claude-code', NOW);
    expect(checkpoint.executionPaused).toBe(false);
    expect(checkpoint.sessions[0]?.agents.map((agent) => agent.completion)).toEqual([
      'unconfirmed',
      'reported_done',
      'unconfirmed',
    ]);
    expect(checkpoint.sessions[0]?.agents[1]).toMatchObject({
      task: 'Check the build',
      parentAgentId: 'main',
    });
    expect(budgetCheckpoint(state, 'codex', NOW).sessions).toEqual([]);
  });
});
