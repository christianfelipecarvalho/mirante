import { describe, expect, it } from 'vitest';
import type { AgentCard, CardState, Harness, SessionLane } from '@mirante/shared';
import { emptyTokenUsage } from '@mirante/shared';
import { summarizeBoard, summarizeProject } from './project-summary.js';

/** Ten minutes after the fixtures' cards were last heard from. */
const NOW = Date.parse('2026-09-20T10:10:00.000Z');

type CardSpec = {
  id?: string;
  state: CardState;
  skill?: string;
  lastEventAt?: string;
  since?: string;
  endedAt?: string;
};

const card = (sessionId: string, spec: CardSpec, index: number): AgentCard =>
  ({
    sessionId,
    agentId: spec.id ?? (index === 0 ? 'main' : `a${index}`),
    status:
      spec.state === 'waiting_approval' ||
      spec.state === 'waiting_input' ||
      spec.state === 'rate_limited'
        ? {
            state: spec.state,
            waitingOn: {
              summary: `waiting ${index}`,
              since: spec.since ?? '2026-09-20T10:05:00.000Z',
            },
          }
        : { state: spec.state },
    ...(spec.skill ? { activeSkill: spec.skill } : {}),
    ...(spec.endedAt ? { endedAt: spec.endedAt } : {}),
    tokens: { ...emptyTokenUsage(), input: 100 },
    startedAt: '2026-09-20T10:00:00.000Z',
    lastEventAt: spec.lastEventAt ?? '2026-09-20T10:09:00.000Z',
    runningChildren: 0,
  }) as AgentCard;

const lane = (
  sessionId: string,
  cards: CardSpec[],
  options: { harness?: Harness; endedAt?: string } = {},
): SessionLane =>
  ({
    sessionId,
    projectPath: '/w/app',
    projectName: 'app',
    entrypoint: 'cli',
    harness: options.harness ?? 'claude-code',
    startedAt: '2026-09-20T10:00:00.000Z',
    ...(options.endedAt ? { endedAt: options.endedAt } : {}),
    tokens: { ...emptyTokenUsage(), input: 1000 },
    cards: cards.map((spec, index) => card(sessionId, spec, index)),
  }) as SessionLane;

describe('what a project card counts', () => {
  it('counts as running only the agents heard from recently', () => {
    const summary = summarizeProject(
      [
        lane('s1', [
          { state: 'thinking' },
          { state: 'tool_running' },
          // Claims to work; silent for an hour. Not running — unknown.
          { state: 'tool_running', lastEventAt: '2026-09-20T09:00:00.000Z' },
          { state: 'done', endedAt: '2026-09-20T10:08:00.000Z' },
        ]),
      ],
      NOW,
    );
    expect(summary.running).toBe(2);
    expect(summary.silent).toBe(1);
    expect(summary.open).toBe(3);
  });

  it('lists the skills of running agents only, most used first', () => {
    const summary = summarizeProject(
      [
        lane('s1', [
          { state: 'thinking', skill: 'ui-ux-pro-max' },
          { state: 'tool_running', skill: 'frontend-design' },
          { state: 'tool_running', skill: 'frontend-design' },
          // At rest: its skill is not in use now.
          { state: 'idle', skill: 'security-review' },
        ]),
      ],
      NOW,
    );
    expect(summary.skills).toEqual([
      { name: 'frontend-design', agents: 2 },
      { name: 'ui-ux-pro-max', agents: 1 },
    ]);
  });

  it('counts open sessions per harness, and ended ones apart', () => {
    const summary = summarizeProject(
      [
        lane('s1', [{ state: 'thinking' }]),
        lane('s2', [{ state: 'thinking' }], { harness: 'codex' }),
        lane('s3', [{ state: 'idle' }], { harness: 'codex' }),
        lane('s4', [{ state: 'done' }], { endedAt: '2026-09-20T10:01:00.000Z' }),
      ],
      NOW,
    );
    expect(summary.sessions).toEqual([
      { harness: 'claude-code', count: 1 },
      { harness: 'codex', count: 2 },
    ]);
    expect(summary.endedSessions).toBe(1);
  });

  it('names the request that has waited longest, and how many wait', () => {
    const summary = summarizeProject(
      [
        lane('s1', [{ state: 'waiting_approval', since: '2026-09-20T10:06:00.000Z' }]),
        lane('s2', [{ state: 'waiting_input', since: '2026-09-20T10:02:00.000Z' }]),
      ],
      NOW,
    );
    expect(summary.awaitingCount).toBe(2);
    expect(summary.awaited?.lane.sessionId).toBe('s2');
  });

  it('keeps a failure in view instead of folding it into a count', () => {
    expect(summarizeProject([lane('s1', [{ state: 'error' }])], NOW).failed).toBe(1);
  });
});

describe('the board in one line', () => {
  it('adds the projects up, counting each skill once', () => {
    const summary = summarizeBoard(
      [
        [lane('s1', [{ state: 'thinking', skill: 'frontend-design' }])],
        [lane('s2', [{ state: 'thinking', skill: 'frontend-design' }], { harness: 'codex' })],
        [lane('s3', [{ state: 'idle' }])],
      ],
      NOW,
    );
    expect(summary).toMatchObject({ running: 2, projectsRunning: 2, skills: 1, awaiting: 0 });
    expect(summary.harnesses).toEqual([
      { harness: 'claude-code', sessions: 2 },
      { harness: 'codex', sessions: 1 },
    ]);
  });
});
