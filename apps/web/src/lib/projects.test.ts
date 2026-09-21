import { describe, expect, it } from 'vitest';
import type { AgentCard, CardState, SessionLane, TimelineEntry } from '@mirante/shared';
import { emptyTokenUsage } from '@mirante/shared';
import { STALE_SESSION_MS, groupProjects, partitionStale } from './projects.js';

/** Ten minutes after the fixtures' cards started: everything working is still live. */
const NOW = Date.parse('2026-09-20T10:10:00.000Z');

const card = (state: CardState, sessionId = 's'): AgentCard =>
  ({
    sessionId,
    agentId: 'main',
    displayName: 'Main',
    status:
      state === 'waiting_approval' || state === 'waiting_input' || state === 'rate_limited'
        ? { state, waitingOn: { summary: 'something' } }
        : { state },
    tokens: emptyTokenUsage(),
    startedAt: '2026-09-20T10:00:00.000Z',
    runningChildren: 0,
  }) as AgentCard;

const lane = (
  sessionId: string,
  projectPath: string,
  states: CardState[],
  options: { startedAt?: string; endedAt?: string } = {},
): SessionLane =>
  ({
    sessionId,
    projectPath,
    projectName: projectPath.split('/').pop() ?? projectPath,
    entrypoint: 'cli',
    startedAt: options.startedAt ?? '2026-09-20T10:00:00.000Z',
    ...(options.endedAt ? { endedAt: options.endedAt } : {}),
    tokens: emptyTokenUsage(),
    cards: states.map((state) => card(state, sessionId)),
  }) as SessionLane;

const tick = (sessionId: string, ts: string): TimelineEntry =>
  ({ id: 1, ts, sessionId, agentId: 'main', kind: 'tool', text: 'x' }) as TimelineEntry;

describe('groupProjects', () => {
  it('puts what needs a decision above what is merely running', () => {
    const groups = groupProjects(
      [lane('s1', '/w/busy', ['tool_running']), lane('s2', '/w/asking', ['waiting_approval'])],
      [],
      NOW,
    );
    expect(groups.map((g) => g.name)).toEqual(['asking', 'busy']);
    expect(groups[0]?.activity).toBe('needs_you');
    expect(groups[0]?.awaiting).toBe(1);
  });

  it('ranks running above rate limited, and both above idle', () => {
    const groups = groupProjects(
      [
        lane('s1', '/w/quiet', ['idle']),
        lane('s2', '/w/limited', ['rate_limited']),
        lane('s3', '/w/running', ['thinking']),
      ],
      [],
      NOW,
    );
    expect(groups.map((g) => g.activity)).toEqual(['working', 'blocked', 'idle']);
  });

  it('sinks a project whose sessions have all ended', () => {
    const groups = groupProjects(
      [
        lane('s1', '/w/over', ['done'], { endedAt: '2026-09-20T11:00:00.000Z' }),
        lane('s2', '/w/quiet', ['idle']),
      ],
      [],
      NOW,
    );
    expect(groups.map((g) => g.name)).toEqual(['quiet', 'over']);
    expect(groups[1]?.liveSessions).toBe(0);
  });

  /**
   * A lane records when it started, never when it last moved. Sorting on the
   * start time alone puts a session that has been silent since morning above one
   * that answered a second ago.
   */
  it('orders equals by when they last did something, not by when they opened', () => {
    const groups = groupProjects(
      [
        lane('old', '/w/started-first', ['idle'], { startedAt: '2026-09-20T08:00:00.000Z' }),
        lane('new', '/w/started-later', ['idle'], { startedAt: '2026-09-20T09:00:00.000Z' }),
      ],
      [tick('old', '2026-09-20T18:00:00.000Z'), tick('new', '2026-09-20T09:30:00.000Z')],
      NOW,
    );
    expect(groups.map((g) => g.name)).toEqual(['started-first', 'started-later']);
  });

  /**
   * Two projects both working would trade places on every tool call if ordered
   * by last event — the row would never hold still long enough to click.
   */
  it('keeps two busy projects in a stable order, newest session first', () => {
    const lanes = [
      lane('a', '/w/opened-first', ['tool_running'], { startedAt: '2026-09-20T08:00:00.000Z' }),
      lane('b', '/w/opened-later', ['thinking'], { startedAt: '2026-09-20T09:00:00.000Z' }),
    ];
    const aMovedLast = groupProjects(lanes, [tick('a', '2026-09-20T10:08:00.000Z')], NOW);
    const bMovedLast = groupProjects(lanes, [tick('b', '2026-09-20T10:09:00.000Z')], NOW);
    expect(aMovedLast.map((g) => g.name)).toEqual(['opened-later', 'opened-first']);
    expect(bMovedLast.map((g) => g.name)).toEqual(['opened-later', 'opened-first']);
  });

  /**
   * Six cards on the real board still said "thinking" from sessions one to
   * fifty-three days old, and held their projects above the one really running.
   */
  it('does not rank a project as working on the word of a card gone silent', () => {
    const ghost = lane('g', '/w/abandoned', ['thinking'], {
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    // Last heard from seven weeks before NOW.
    ghost.cards = ghost.cards.map((card) => ({ ...card, lastEventAt: '2026-08-01T10:05:00.000Z' }));
    const busy = lane('b', '/w/busy', ['tool_running'], { startedAt: '2026-09-20T10:05:00.000Z' });
    const groups = groupProjects([ghost, busy], [], NOW);
    expect(groups.map((g) => [g.name, g.activity])).toEqual([
      ['busy', 'working'],
      ['abandoned', 'idle'],
    ]);
  });

  it('gathers every session of a project under one entry', () => {
    const groups = groupProjects(
      [
        lane('s1', '/w/one', ['idle']),
        lane('s2', '/w/one', ['idle']),
        lane('s3', '/w/two', ['idle']),
      ],
      [],
      NOW,
    );
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.name === 'one')?.lanes).toHaveLength(2);
  });

  it('counts an ended session as finished even when its cards never said done', () => {
    const groups = groupProjects(
      [lane('s1', '/w/killed', ['tool_running'], { endedAt: '2026-09-20T11:00:00.000Z' })],
      [],
      NOW,
    );
    expect(groups[0]?.activity).toBe('finished');
  });
});

describe('partitionStale', () => {
  const at = (iso: string) => Date.parse(iso);

  it('hides a session silent for longer than three days', () => {
    const old = lane('old', '/w/a', ['idle'], { startedAt: '2026-09-10T10:00:00.000Z' });
    const recent = lane('new', '/w/b', ['idle'], { startedAt: '2026-09-19T10:00:00.000Z' });
    const { current, stale } = partitionStale([old, recent], [], at('2026-09-20T10:10:00.000Z'));
    expect(current.map((l) => l.sessionId)).toEqual(['new']);
    expect(stale.map((l) => l.sessionId)).toEqual(['old']);
  });

  it('brings an old session back the moment it does something', () => {
    const old = lane('old', '/w/a', ['idle'], { startedAt: '2026-09-10T10:00:00.000Z' });
    const { current } = partitionStale(
      [old],
      [tick('old', '2026-09-20T10:09:00.000Z')],
      at('2026-09-20T10:10:00.000Z'),
    );
    expect(current.map((l) => l.sessionId)).toEqual(['old']);
  });

  it("counts a card's own last signal as activity", () => {
    const old = lane('old', '/w/a', ['idle'], { startedAt: '2026-09-10T10:00:00.000Z' });
    old.cards = old.cards.map((card) => ({ ...card, lastEventAt: '2026-09-20T09:00:00.000Z' }));
    expect(partitionStale([old], [], at('2026-09-20T10:10:00.000Z')).stale).toEqual([]);
  });

  it('hides an old session even if it claims to wait on you, since approvals expire', () => {
    const asking = lane('ask', '/w/a', ['waiting_approval'], {
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    expect(partitionStale([asking], [], at('2026-09-20T10:10:00.000Z')).stale).toHaveLength(1);
  });

  it('keeps the threshold at three days', () => {
    expect(STALE_SESSION_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });
});
