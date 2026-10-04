import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from './agent.js';
import { dedupeKeys } from './dedupe.js';
import type { MiranteEvent } from './event.js';
import { BoardProjector } from './projector.js';
import { emptyTokenUsage } from './usage.js';

let nextId = 0;
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 19, 12, 0, seconds)).toISOString();

const ev = (
  partial: Partial<MiranteEvent> & Pick<MiranteEvent, 'kind' | 'payload'>,
): MiranteEvent =>
  ({
    id: (nextId += 1),
    ts: at(nextId),
    receivedTs: at(nextId),
    source: 'transcript',
    sessionId: 'sess-1',
    projectPath: '/home/user/project',
    agentId: MAIN_AGENT_ID,
    ...partial,
  }) as MiranteEvent;

const board = (...events: MiranteEvent[]) => {
  const projector = new BoardProjector();
  projector.applyAll(events);
  return projector.snapshot();
};

const cardOf = (state: ReturnType<typeof board>, agentId: string) =>
  state.sessions[0]?.cards.find((c) => c.agentId === agentId);

const sessionStart = () =>
  ev({
    kind: 'session.started',
    payload: { entrypoint: 'cli', cwd: '/home/user/project' },
  });

const spawn = (agentId: string, spawnMode: 'sync' | 'async', agentType = 'Explore') =>
  ev({
    kind: 'agent.started',
    agentId,
    parentAgentId: MAIN_AGENT_ID,
    payload: { agentType, spawnMode, toolUseId: `toolu_${agentId}` },
  });

describe('a synchronous subagent blocks its parent', () => {
  const state = board(sessionStart(), spawn('a1', 'sync', 'security-reviewer'));

  it('puts the parent in waiting_subagent', () => {
    expect(cardOf(state, MAIN_AGENT_ID)?.status.state).toBe('waiting_subagent');
  });

  it('says what it is waiting on, by name', () => {
    // The central product rule: a card that only says "waiting" is a bug.
    expect(cardOf(state, MAIN_AGENT_ID)?.status.waitingOn?.summary).toBe(
      'Waiting on security-reviewer',
    );
  });

  it('releases the parent when the child hands back', () => {
    const after = board(
      sessionStart(),
      spawn('a1', 'sync'),
      ev({
        kind: 'agent.finished',
        agentId: 'a1',
        parentAgentId: MAIN_AGENT_ID,
        payload: { outcome: 'ok', handedBackTo: MAIN_AGENT_ID },
      }),
    );
    expect(cardOf(after, MAIN_AGENT_ID)?.status.state).toBe('thinking');
    expect(cardOf(after, 'a1')?.status.state).toBe('done');
    expect(cardOf(after, MAIN_AGENT_ID)?.runningChildren).toBe(0);
  });
});

describe('an asynchronous subagent does not block its parent', () => {
  const state = board(
    sessionStart(),
    ev({ kind: 'prompt.submitted', payload: { preview: 'review this', charCount: 11 } }),
    spawn('a1', 'async'),
    spawn('a2', 'async'),
  );

  it('leaves the parent working rather than waiting', () => {
    // status: "async_launched" means the parent keeps going. Showing it as
    // blocked would misreport the session. See docs/EVENT_MAP.md §6 D3.
    expect(cardOf(state, MAIN_AGENT_ID)?.status.state).not.toBe('waiting_subagent');
  });

  it('counts the running children instead, for a badge', () => {
    expect(cardOf(state, MAIN_AGENT_ID)?.runningChildren).toBe(2);
  });
});

describe('the timeline names both sides of a handoff', () => {
  const state = board(
    sessionStart(),
    spawn('a1', 'async', 'Explore'),
    ev({
      kind: 'agent.finished',
      agentId: 'a1',
      parentAgentId: MAIN_AGENT_ID,
      payload: { outcome: 'ok', handedBackTo: MAIN_AGENT_ID },
    }),
  );

  it('records who started and who it went back to', () => {
    const kinds = state.timeline.map((t) => `${t.kind}:${t.text}`);
    expect(kinds).toContain('handoff.start:main → Explore');
    expect(kinds).toContain('handoff.end:Explore → main');
  });
});

describe('approval', () => {
  const requested = ev({
    kind: 'permission.requested',
    source: 'hook',
    payload: {
      requestId: 'req-1',
      toolName: 'Bash',
      inputPreview: 'rm -rf build/',
      decideBy: at(30),
    },
  });

  it('blocks the card and names the command awaiting a decision', () => {
    const state = board(sessionStart(), requested);
    expect(cardOf(state, MAIN_AGENT_ID)?.status.waitingOn?.summary).toBe(
      'Approve Bash: rm -rf build/',
    );
    expect(state.pendingApprovals).toHaveLength(1);
  });

  it('clears when the terminal answers instead of the UI', () => {
    const state = board(
      sessionStart(),
      requested,
      ev({
        kind: 'permission.resolved',
        source: 'hook',
        payload: { requestId: 'req-1', decision: 'ask', via: 'fallback' },
      }),
    );
    expect(cardOf(state, MAIN_AGENT_ID)?.status.state).toBe('thinking');
    expect(state.pendingApprovals).toHaveLength(0);
    expect(state.timeline.map((t) => t.text)).toContain('Permission asked in terminal');
  });
});

describe('two sources reporting the same fact', () => {
  const key = dedupeKeys.toolStarted('toolu_1');
  const fromHook = ev({
    kind: 'tool.started',
    source: 'hook',
    dedupeKey: key,
    payload: { toolUseId: 'toolu_1', toolName: 'Bash', summary: 'from hook' },
  });
  const fromTranscript = ev({
    kind: 'tool.started',
    source: 'transcript',
    dedupeKey: key,
    payload: { toolUseId: 'toolu_1', toolName: 'Bash', summary: 'from transcript' },
  });

  it('renders the tool once, not twice', () => {
    const state = board(sessionStart(), fromHook, fromTranscript);
    expect(state.timeline.filter((t) => t.kind === 'tool')).toHaveLength(1);
  });

  it('lets the transcript correct the hook', () => {
    const state = board(sessionStart(), fromHook, fromTranscript);
    expect(cardOf(state, MAIN_AGENT_ID)?.currentTool?.summary).toBe('from transcript');
  });

  it('does not let a hook overwrite the transcript', () => {
    const state = board(sessionStart(), fromTranscript, fromHook);
    expect(cardOf(state, MAIN_AGENT_ID)?.currentTool?.summary).toBe('from transcript');
  });
});

describe('plan limits', () => {
  const limited = (usedPercentage: number) => {
    const projector = new BoardProjector();
    const ts = '2026-09-21T12:00:00.000Z';
    projector.applyAll([
      sessionStart(),
      ev({ kind: 'prompt.submitted', payload: { preview: 'go', charCount: 2 } }),
      ev({
        kind: 'plan.usage.updated',
        source: 'statusline',
        ts,
        // Far in the future: the overlay now consults the clock, and a reset
        // time that passes while the suite is still in use would turn this
        // test red on some later evening.
        payload: { usage: { fiveHour: { usedPercentage, resetsAt: 4102444800 } } },
      }),
    ]);
    return projector.snapshot(Date.parse(ts));
  };

  it('shows active cards as rate limited at the ceiling, naming the reset', () => {
    const card = cardOf(limited(100), MAIN_AGENT_ID);
    expect(card?.status.state).toBe('rate_limited');
    expect(card?.status.waitingOn?.summary).toContain('5-hour limit');
  });

  /**
   * A reading of 100% from last night, whose window reset at 22:00, marked every
   * card on the board "at the 5-hour limit, waiting 9h 32m" the next morning.
   */
  it('ignores a reading whose window has already reset', () => {
    const projector = new BoardProjector();
    projector.applyAll([
      ...[
        sessionStart(),
        ev({ kind: 'prompt.submitted', payload: { preview: 'go', charCount: 2 } }),
      ],
      ev({
        kind: 'plan.usage.updated',
        source: 'statusline',
        ts: '2026-09-21T00:58:00.000Z',
        payload: { usage: { fiveHour: { usedPercentage: 100, resetsAt: 1789952400 } } },
      }),
    ]);
    const before = projector.snapshot(Date.parse('2026-09-21T00:59:00Z'));
    const after = projector.snapshot(Date.parse('2026-09-21T01:00:01Z'));
    const main = (state: typeof before) =>
      state.sessions[0]?.cards.find((c) => c.agentId === MAIN_AGENT_ID);
    expect(main(before)?.status.state).toBe('rate_limited');
    expect(main(after)?.status.state).toBe('thinking');
  });

  it('names the window by a key the interface can translate', () => {
    expect(cardOf(limited(100), MAIN_AGENT_ID)?.status.waitingOn?.subject).toBe('fiveHour');
  });

  it("keeps the status line's spend limit when a reading without one arrives", () => {
    const projector = new BoardProjector();
    projector.applyAll([
      ev({
        kind: 'plan.usage.updated',
        source: 'statusline',
        ts: '2026-09-21T12:00:00.000Z',
        payload: {
          usage: { fiveHour: { usedPercentage: 10 }, spendLimit: { usedPercentage: 40 } },
        },
      }),
      ev({
        kind: 'plan.usage.updated',
        source: 'usage-cache',
        ts: '2026-09-21T12:01:00.000Z',
        payload: { usage: { fiveHour: { usedPercentage: 12 } } },
      }),
    ]);
    const usage = projector.snapshot().planUsage;
    expect(usage?.fiveHour?.usedPercentage).toBe(12);
    expect(usage?.spendLimit?.usedPercentage).toBe(40);
  });

  it('stops asserting a limit it cannot date once the reading is over an hour old', () => {
    const projector = new BoardProjector();
    projector.applyAll([
      sessionStart(),
      ev({ kind: 'prompt.submitted', payload: { preview: 'go', charCount: 2 } }),
      ev({
        kind: 'plan.usage.updated',
        source: 'statusline',
        ts: '2026-09-21T12:00:00.000Z',
        payload: { usage: { fiveHour: { usedPercentage: 100 } } },
      }),
    ]);
    const main = (at: string) =>
      projector
        .snapshot(Date.parse(at))
        .sessions[0]?.cards.find((c) => c.agentId === MAIN_AGENT_ID);
    expect(main('2026-09-21T12:30:00Z')?.status.state).toBe('rate_limited');
    expect(main('2026-09-21T13:30:00Z')?.status.state).toBe('thinking');
  });

  it('leaves cards alone below the ceiling', () => {
    expect(cardOf(limited(99), MAIN_AGENT_ID)?.status.state).toBe('thinking');
  });

  it('does not treat a future reset as evidence that an old reading is still fresh', () => {
    const projector = new BoardProjector();
    projector.applyAll([
      sessionStart(),
      ev({ kind: 'prompt.submitted', payload: { preview: 'go', charCount: 2 } }),
      ev({
        kind: 'plan.usage.updated',
        ts: '2026-09-21T12:00:00.000Z',
        payload: { usage: { sevenDay: { usedPercentage: 100, resetsAt: 4102444800 } } },
      }),
    ]);
    expect(
      projector.snapshot(Date.parse('2026-09-21T13:01:00Z')).sessions[0]?.cards[0]?.status.state,
    ).toBe('thinking');
  });

  it('keeps real activity available for polling underneath a limit overlay', () => {
    const projector = new BoardProjector();
    const ts = '2026-09-21T12:00:00.000Z';
    projector.applyAll([
      ev({ kind: 'session.started', ts, payload: { entrypoint: 'cli', cwd: '/project' } }),
      ev({ kind: 'prompt.submitted', ts, payload: { preview: 'go', charCount: 2 } }),
      ev({
        kind: 'plan.usage.updated',
        ts,
        payload: { usage: { fiveHour: { usedPercentage: 100, resetsAt: 4102444800 } } },
      }),
    ]);
    expect(projector.snapshot(Date.parse(ts)).sessions[0]?.cards[0]?.status.state).toBe(
      'rate_limited',
    );
    expect(projector.hasLiveWork('claude-code', Date.parse(ts))).toBe(true);
    expect(projector.hasLiveWork('codex', Date.parse(ts))).toBe(false);
    expect(projector.hasLiveWork('claude-code', Date.parse(ts) + 31 * 60_000)).toBe(false);
  });

  it('does not reopen a finished card', () => {
    const state = board(
      sessionStart(),
      spawn('a1', 'async'),
      ev({ kind: 'agent.finished', agentId: 'a1', payload: { outcome: 'ok' } }),
      ev({
        kind: 'plan.usage.updated',
        source: 'statusline',
        payload: { usage: { fiveHour: { usedPercentage: 100 } } },
      }),
    );
    expect(cardOf(state, 'a1')?.status.state).toBe('done');
  });
});

describe('sessions', () => {
  it('keeps one lane per session, with the project name in the header', () => {
    const projector = new BoardProjector();
    projector.apply(sessionStart());
    projector.apply(
      ev({
        kind: 'session.started',
        sessionId: 'sess-2',
        projectPath: '/home/user/other',
        payload: { entrypoint: 'vscode', cwd: '/home/user/other' },
      }),
    );
    const state = projector.snapshot();
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions.map((s) => s.projectName).sort()).toEqual(['other', 'project']);
    expect(state.sessions.map((s) => s.entrypoint).sort()).toEqual(['cli', 'vscode']);
  });

  it('closes every open card when the session ends', () => {
    const state = board(
      sessionStart(),
      spawn('a1', 'async'),
      ev({ kind: 'session.ended', payload: {} }),
    );
    expect(state.sessions[0]?.cards.every((c) => c.status.state === 'done')).toBe(true);
  });

  it('reopens a resumed session on a new prompt while completed children stay closed', () => {
    const projector = new BoardProjector();
    projector.applyAll([
      ev({ kind: 'session.started', ts: at(0), payload: { entrypoint: 'cli', cwd: '/project' } }),
      ev({
        kind: 'agent.started',
        ts: at(5),
        agentId: 'old-child',
        parentAgentId: MAIN_AGENT_ID,
        payload: { agentType: 'Explore', spawnMode: 'async' },
      }),
      ev({ kind: 'session.ended', ts: at(10), payload: {} }),
      ev({
        kind: 'prompt.submitted',
        ts: at(20),
        payload: { preview: 'continue', charCount: 8 },
      }),
    ]);
    const state = projector.snapshot(Date.parse(at(20)));
    expect(state.sessions[0]?.endedAt).toBeUndefined();
    expect(cardOf(state, MAIN_AGENT_ID)?.endedAt).toBeUndefined();
    expect(cardOf(state, MAIN_AGENT_ID)?.status.state).toBe('thinking');
    expect(cardOf(state, MAIN_AGENT_ID)?.runningChildren).toBe(0);
    expect(cardOf(state, 'old-child')?.status.state).toBe('done');
    expect(projector.hasLiveWork('claude-code', Date.parse(at(20)))).toBe(true);
  });

  it('can reopen on a tool when the resume hook and prompt were missed', () => {
    const state = board(
      ev({ kind: 'session.started', ts: at(0), payload: { entrypoint: 'cli', cwd: '/project' } }),
      ev({ kind: 'session.ended', ts: at(10), payload: {} }),
      ev({
        kind: 'tool.started',
        ts: at(20),
        payload: { toolUseId: 'resumed-tool', toolName: 'Read', summary: 'continue reading' },
      }),
    );
    expect(state.sessions[0]?.endedAt).toBeUndefined();
    expect(cardOf(state, MAIN_AGENT_ID)?.endedAt).toBeUndefined();
    expect(cardOf(state, MAIN_AGENT_ID)?.status.state).toBe('tool_running');
  });

  it('keeps repeated resumes and closes distinct even with legacy dedupe keys', () => {
    const projector = new BoardProjector();
    projector.apply(
      ev({
        kind: 'session.started',
        ts: at(0),
        source: 'transcript',
        dedupeKey: dedupeKeys.sessionStarted('sess-1'),
        payload: { entrypoint: 'vscode', cwd: '/project' },
      }),
    );
    for (const seconds of [10, 30]) {
      projector.apply(
        ev({
          kind: 'session.ended',
          ts: at(seconds),
          source: 'hook',
          dedupeKey: dedupeKeys.sessionEnded('sess-1'),
          payload: {},
        }),
      );
      expect(projector.snapshot().sessions[0]?.endedAt).toBe(at(seconds));
      projector.apply(
        ev({
          kind: 'session.started',
          ts: at(seconds + 5),
          source: 'hook',
          dedupeKey: dedupeKeys.sessionStarted('sess-1'),
          payload: { entrypoint: 'unknown', cwd: '/project', resumed: true },
        }),
      );
      const state = projector.snapshot();
      expect(state.sessions[0]?.endedAt).toBeUndefined();
      expect(state.sessions[0]?.entrypoint).toBe('vscode');
      expect(cardOf(state, MAIN_AGENT_ID)?.status.state).toBe('idle');
      expect(cardOf(state, MAIN_AGENT_ID)?.endedAt).toBeUndefined();
    }
  });

  it('does not close resumed work when an earlier session end arrives late', () => {
    const state = board(
      ev({ kind: 'session.started', ts: at(0), payload: { entrypoint: 'cli', cwd: '/project' } }),
      ev({ kind: 'session.ended', ts: at(10), payload: {} }),
      ev({ kind: 'prompt.submitted', ts: at(30), payload: { preview: 'resume', charCount: 6 } }),
      ev({ kind: 'session.ended', ts: at(20), payload: {} }),
    );
    expect(state.sessions[0]?.endedAt).toBeUndefined();
    expect(cardOf(state, MAIN_AGENT_ID)?.status.state).toBe('thinking');
  });

  it('does not reopen on historical work or a newer usage reading', () => {
    const state = board(
      ev({ kind: 'session.started', ts: at(0), payload: { entrypoint: 'cli', cwd: '/project' } }),
      ev({ kind: 'session.ended', ts: at(20), payload: {} }),
      ev({ kind: 'prompt.submitted', ts: at(5), payload: { preview: 'old', charCount: 3 } }),
      ev({
        kind: 'tool.started',
        ts: at(10),
        payload: { toolUseId: 'old-tool', toolName: 'Read', summary: 'old read' },
      }),
      ev({
        kind: 'usage.updated',
        ts: at(30),
        payload: { scope: 'agent', tokens: emptyTokenUsage() },
      }),
    );
    expect(state.sessions[0]?.endedAt).toBe(at(20));
    expect(cardOf(state, MAIN_AGENT_ID)?.status.state).toBe('done');
    expect(cardOf(state, MAIN_AGENT_ID)?.currentTool).toBeUndefined();
  });
});

describe('a card never goes blank', () => {
  // "Thinking" with no other text is the state a card is most often caught in,
  // and on its own it answers none of the questions this board exists for.
  const withTool = () =>
    board(
      sessionStart(),
      ev({ kind: 'prompt.submitted', payload: { preview: 'fix the build', charCount: 13 } }),
      ev({
        kind: 'tool.started',
        payload: { toolUseId: 'toolu_9', toolName: 'Bash', summary: 'pnpm build' },
      }),
    );

  it('shows the running tool while it runs', () => {
    const card = cardOf(withTool(), MAIN_AGENT_ID);
    expect(card?.activity).toBe('Bash: pnpm build');
    expect(card?.status.state).toBe('tool_running');
  });

  it('remembers the last action once the tool returns', () => {
    const state = board(
      sessionStart(),
      ev({ kind: 'prompt.submitted', payload: { preview: 'fix the build', charCount: 13 } }),
      ev({
        kind: 'tool.started',
        payload: { toolUseId: 'toolu_9', toolName: 'Bash', summary: 'pnpm build' },
      }),
      ev({ kind: 'tool.finished', payload: { toolUseId: 'toolu_9', toolName: 'Bash' } }),
    );
    const card = cardOf(state, MAIN_AGENT_ID);
    expect(card?.activity).toBeUndefined();
    expect(card?.lastActivity).toBe('Bash: pnpm build');
    expect(card?.status.state).toBe('thinking');
  });

  it('falls back to the prompt when no tool has run yet', () => {
    const state = board(
      sessionStart(),
      ev({ kind: 'prompt.submitted', payload: { preview: 'fix the build', charCount: 13 } }),
    );
    // Kept raw, with a marker, so the interface can quote it in the reader's
    // language instead of showing an English "Prompt: " prefix.
    expect(cardOf(state, MAIN_AGENT_ID)?.lastActivity).toBe('fix the build');
    expect(cardOf(state, MAIN_AGENT_ID)?.lastActivityKind).toBe('prompt');
  });
});

describe('what an agent was asked to do', () => {
  // Three subagents can all be "general-purpose" while one is the designer, one
  // the architect and one the PM. The task is the only thing that tells them
  // apart, and the first tool call used to overwrite it.
  const withTask = () =>
    board(
      sessionStart(),
      ev({
        kind: 'agent.started',
        agentId: 'a1',
        parentAgentId: MAIN_AGENT_ID,
        payload: {
          agentType: 'general-purpose',
          spawnMode: 'async',
          description: 'Designer: tutoriais interativos',
        },
      }),
    );

  it('is kept on the card', () => {
    expect(cardOf(withTask(), 'a1')?.task).toBe('Designer: tutoriais interativos');
  });

  it('survives the agent running a tool', () => {
    const state = board(
      sessionStart(),
      ev({
        kind: 'agent.started',
        agentId: 'a1',
        parentAgentId: MAIN_AGENT_ID,
        payload: {
          agentType: 'general-purpose',
          spawnMode: 'async',
          description: 'Designer: tutoriais interativos',
        },
      }),
      ev({
        kind: 'tool.started',
        agentId: 'a1',
        payload: { toolUseId: 't1', toolName: 'Grep', summary: 'button' },
      }),
    );
    expect(cardOf(state, 'a1')?.task).toBe('Designer: tutoriais interativos');
    expect(cardOf(state, 'a1')?.activity).toBe('Grep: button');
  });

  it('is absent when the agent was launched without one', () => {
    expect(cardOf(board(sessionStart(), spawn('a2', 'async')), 'a2')?.task).toBeUndefined();
  });
});

describe('an agent Mirante only saw finish', () => {
  // Its SubagentStop arrived but nothing else: it started while the daemon was
  // not listening. There is no type, no task, no tokens and no duration.
  const finishOnly = () =>
    board(
      sessionStart(),
      ev({
        kind: 'agent.finished',
        agentId: 'ghost-1',
        parentAgentId: MAIN_AGENT_ID,
        source: 'hook',
        payload: { outcome: 'ok', handedBackTo: MAIN_AGENT_ID },
      }),
    );

  it('does not become an empty card', () => {
    // A box with an opaque id for a name and zeroes for every number is worse
    // than not showing it.
    expect(cardOf(finishOnly(), 'ghost-1')).toBeUndefined();
  });

  it('is still recorded, so the timeline does not lie by omission', () => {
    expect(finishOnly().timeline.some((entry) => entry.kind === 'handoff.end')).toBe(true);
  });

  it('leaves a properly observed agent alone', () => {
    const state = board(
      sessionStart(),
      spawn('a1', 'async', 'Explore'),
      ev({
        kind: 'agent.finished',
        agentId: 'a1',
        parentAgentId: MAIN_AGENT_ID,
        payload: { outcome: 'ok', handedBackTo: MAIN_AGENT_ID },
      }),
    );
    expect(cardOf(state, 'a1')?.status.state).toBe('done');
  });
});

describe('a start re-read after the parser learned more', () => {
  const start = (extra: Record<string, unknown>) =>
    ev({
      kind: 'agent.started',
      agentId: 'sub1',
      parentAgentId: MAIN_AGENT_ID,
      dedupeKey: dedupeKeys.agentStarted('sub1'),
      payload: { agentType: 'ui-ux-designer', spawnMode: 'async', ...extra },
    });

  it('takes the fuller report of the same start, without counting it twice', () => {
    const state = board(
      sessionStart(),
      start({ description: 'review the card' }),
      // The transcript is re-read whole, and the parser now reads the brief.
      start({ description: 'review the card', brief: 'Revise a hierarquia…', briefCharCount: 900 }),
    );

    expect(cardOf(state, 'sub1')?.brief).toBe('Revise a hierarquia…');
    expect(cardOf(state, 'sub1')?.briefCharCount).toBe(900);
    // The parent must not now believe two agents are running.
    expect(cardOf(state, MAIN_AGENT_ID)?.runningChildren).toBe(1);
  });
});

describe('the harness a session runs in', () => {
  it('is Claude Code unless the session says otherwise', () => {
    // Logs written before Codex was observed carry no harness at all.
    expect(board(sessionStart()).sessions[0]?.harness).toBe('claude-code');
  });

  it('takes the harness and its version from the start of a Codex session', () => {
    const lane = board(
      ev({
        kind: 'session.started',
        source: 'codex-rollout',
        payload: { entrypoint: 'vscode', cwd: '/p', harness: 'codex', harnessVersion: '0.155.0' },
      }),
    ).sessions[0];
    expect(lane?.harness).toBe('codex');
    expect(lane?.harnessVersion).toBe('0.155.0');
  });

  it('keeps the Claude plan limit off Codex cards', () => {
    const state = board(
      ev({
        kind: 'session.started',
        source: 'codex-rollout',
        payload: { entrypoint: 'vscode', cwd: '/p', harness: 'codex' },
      }),
      ev({ kind: 'prompt.submitted', payload: { preview: 'go', charCount: 2 } }),
      ev({
        kind: 'plan.usage.updated',
        source: 'statusline',
        payload: { usage: { fiveHour: { usedPercentage: 100, resetsAt: 4102444800 } } },
      }),
    );
    // The reading is Claude's; a Codex agent is not stopped by it.
    expect(cardOf(state, MAIN_AGENT_ID)?.status.state).toBe('thinking');
  });
});

describe('an agent given a second assignment', () => {
  const started = (key: string, followUp?: boolean) =>
    ev({
      kind: 'agent.started',
      agentId: 'sub1',
      parentAgentId: MAIN_AGENT_ID,
      dedupeKey: key,
      payload: { agentType: 'dba', spawnMode: 'async', ...(followUp ? { followUp } : {}) },
    });
  const finished = (key: string) =>
    ev({
      kind: 'agent.finished',
      agentId: 'sub1',
      parentAgentId: MAIN_AGENT_ID,
      dedupeKey: key,
      payload: { outcome: 'ok' },
    });

  it('comes back to work, and counts against its parent again', () => {
    const state = board(
      sessionStart(),
      started(dedupeKeys.agentStarted('sub1')),
      finished(dedupeKeys.agentFollowUpFinished('sub1', 't1')),
      started(dedupeKeys.agentFollowUp('sub1', 't2'), true),
    );
    expect(cardOf(state, 'sub1')?.status.state).toBe('thinking');
    expect(cardOf(state, 'sub1')?.endedAt).toBeUndefined();
    expect(cardOf(state, MAIN_AGENT_ID)?.runningChildren).toBe(1);
  });

  it('finishes the second assignment on its own terms', () => {
    const state = board(
      sessionStart(),
      started(dedupeKeys.agentStarted('sub1')),
      finished(dedupeKeys.agentFollowUpFinished('sub1', 't1')),
      started(dedupeKeys.agentFollowUp('sub1', 't2'), true),
      finished(dedupeKeys.agentFollowUpFinished('sub1', 't2')),
    );
    expect(cardOf(state, 'sub1')?.status.state).toBe('done');
    expect(cardOf(state, MAIN_AGENT_ID)?.runningChildren).toBe(0);
  });

  it('is not revived by a late first report of an ordinary start', () => {
    // The hook saw the agent work and finish; the transcript's report of its
    // start is read afterwards. That is history arriving late, not new work.
    const state = board(
      sessionStart(),
      ev({
        kind: 'tool.started',
        agentId: 'sub1',
        parentAgentId: MAIN_AGENT_ID,
        source: 'hook',
        payload: { toolUseId: 'toolu_1', toolName: 'Bash', summary: 'ls' },
      }),
      finished(dedupeKeys.agentFinished('sub1')),
      started(dedupeKeys.agentStarted('sub1')),
    );
    expect(cardOf(state, 'sub1')?.status.state).toBe('done');
  });
});

describe('the skill a card is using', () => {
  it('belongs to the request that invoked it', () => {
    const state = board(
      sessionStart(),
      ev({ kind: 'prompt.submitted', payload: { preview: 'design it', charCount: 9 } }),
      ev({ kind: 'skill.invoked', payload: { skillName: 'frontend-design' } }),
      ev({ kind: 'prompt.submitted', payload: { preview: 'now the tests', charCount: 13 } }),
    );
    // A skill from the last request is not in use for this one.
    expect(cardOf(state, MAIN_AGENT_ID)?.activeSkill).toBeUndefined();
  });
});

describe('a skill reported after the next request', () => {
  it('is kept in the timeline but not shown as in use', () => {
    const projector = new BoardProjector();
    const first = ev({ kind: 'prompt.submitted', payload: { preview: 'a', charCount: 1 } });
    const skill = ev({ kind: 'skill.invoked', payload: { skillName: 'review' } });
    const second = ev({ kind: 'prompt.submitted', payload: { preview: 'b', charCount: 1 } });
    // Arrives last, dated between the two prompts: a transcript read late.
    projector.applyAll([sessionStart(), first, second, { ...skill, id: 999 }]);
    const state = projector.snapshot();
    expect(cardOf(state, MAIN_AGENT_ID)?.activeSkill).toBeUndefined();
    expect(state.timeline.some((row) => row.kind === 'skill')).toBe(true);
  });
});

describe('the model a card names', () => {
  const usage = (agentId: string, model: string) =>
    ev({
      kind: 'usage.updated',
      agentId,
      parentAgentId: agentId === MAIN_AGENT_ID ? undefined : MAIN_AGENT_ID,
      payload: { scope: 'agent', tokens: emptyTokenUsage(), model },
    } as Partial<MiranteEvent> & Pick<MiranteEvent, 'kind' | 'payload'>);

  it('is the one the replies name, over the alias the spawn declared', () => {
    const start = ev({
      kind: 'agent.started',
      agentId: 'sub1',
      parentAgentId: MAIN_AGENT_ID,
      dedupeKey: dedupeKeys.agentStarted('sub1'),
      payload: { agentType: 'Plan', spawnMode: 'async', model: 'opus' },
    });
    const state = board(sessionStart(), start, usage('sub1', 'claude-opus-5-5'), {
      // The same start, read again later.
      ...start,
      id: 500,
    });
    expect(cardOf(state, 'sub1')?.model).toBe('claude-opus-5-5');
  });

  it('follows a switch, and is not put back by a reply reported late', () => {
    const projector = new BoardProjector();
    const early = usage(MAIN_AGENT_ID, 'claude-opus-5-5');
    const late = usage(MAIN_AGENT_ID, 'claude-sonnet-5');
    projector.applyAll([sessionStart(), early, late, { ...early, id: 900 }]);
    expect(cardOf(projector.snapshot(), MAIN_AGENT_ID)?.model).toBe('claude-sonnet-5');
  });
});

describe('reported reasoning effort', () => {
  it('keeps each agent independent and ignores older settings arriving late', () => {
    const projector = new BoardProjector();
    projector.applyAll([
      ev({ kind: 'session.started', ts: at(0), payload: { entrypoint: 'cli', cwd: '/project' } }),
      ev({ kind: 'agent.metadata.updated', ts: at(10), payload: { effort: 'ultra' } }),
      ev({
        kind: 'agent.metadata.updated',
        agentId: 'child',
        ts: at(15),
        payload: { effort: 'medium' },
      }),
      ev({ kind: 'agent.metadata.updated', ts: at(20), payload: { effort: 'xhigh' } }),
      ev({ kind: 'agent.metadata.updated', ts: at(5), payload: { effort: 'low' } }),
    ]);
    expect(cardOf(projector.snapshot(), MAIN_AGENT_ID)?.effort).toBe('xhigh');
    expect(cardOf(projector.snapshot(), 'child')?.effort).toBe('medium');
  });

  it('clears unavailable effort for a new turn without inventing activity or spend', () => {
    const projector = new BoardProjector();
    projector.applyAll([
      ev({ kind: 'session.started', ts: at(0), payload: { entrypoint: 'cli', cwd: '/project' } }),
      ev({ kind: 'agent.metadata.updated', ts: at(10), payload: { effort: 'high' } }),
      ev({ kind: 'session.ended', ts: at(15), payload: {} }),
      ev({
        kind: 'agent.metadata.updated',
        ts: at(20),
        payload: { model: 'gpt-6-sol', effort: null },
      }),
      ev({ kind: 'agent.metadata.updated', ts: at(5), payload: { effort: 'medium' } }),
    ]);
    const state = projector.snapshot();
    expect(cardOf(state, MAIN_AGENT_ID)?.effort).toBeUndefined();
    expect(cardOf(state, MAIN_AGENT_ID)?.model).toBe('gpt-6-sol');
    expect(cardOf(state, MAIN_AGENT_ID)?.status.state).toBe('done');
    expect(state.sessions[0]?.endedAt).toBe(at(15));
    expect(state.sessions[0]?.tokens).toEqual(emptyTokenUsage());
  });
});
