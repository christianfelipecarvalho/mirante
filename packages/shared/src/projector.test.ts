import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from './agent.js';
import { dedupeKeys } from './dedupe.js';
import type { MiranteEvent } from './event.js';
import { BoardProjector } from './projector.js';

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
  const limited = (usedPercentage: number) =>
    board(
      sessionStart(),
      ev({ kind: 'prompt.submitted', payload: { preview: 'go', charCount: 2 } }),
      ev({
        kind: 'plan.usage.updated',
        source: 'statusline',
        payload: { usage: { fiveHour: { usedPercentage, resetsAt: 1790000000 } } },
      }),
    );

  it('shows active cards as rate limited at the ceiling, naming the reset', () => {
    const card = cardOf(limited(100), MAIN_AGENT_ID);
    expect(card?.status.state).toBe('rate_limited');
    expect(card?.status.waitingOn?.summary).toContain('5-hour limit');
  });

  it('leaves cards alone below the ceiling', () => {
    expect(cardOf(limited(99), MAIN_AGENT_ID)?.status.state).toBe('thinking');
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
    expect(cardOf(state, MAIN_AGENT_ID)?.lastActivity).toBe('Prompt: fix the build');
  });
});
