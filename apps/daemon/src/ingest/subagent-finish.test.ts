import { describe, expect, it } from 'vitest';
import { BoardProjector, MAIN_AGENT_ID, type DraftEvent, type MiranteEvent } from '@mirante/shared';
import { hookPayloadSchema, hookToEvents } from './hooks.js';
import { parseSessionTranscript } from './transcript/parse.js';

/**
 * Shapes copied from the session of 2026-09-20, redacted. The notification entry
 * has no sessionId and no cwd — only a timestamp — and a subagent that hands
 * back through a tool ends its own file on an `attachment`, never on the
 * assistant `end_turn` the old heuristic waited for. See EVENT_MAP D11.
 */
const SESSION = 'sess-1';
const EXPLORE = 'a1659bf41f0847af8';
const DESIGNER = 'a4a55aac3dcb859e7';

const prompt = {
  type: 'user',
  uuid: 'u1',
  sessionId: SESSION,
  cwd: '/home/user/project',
  entrypoint: 'claude-vscode',
  promptId: 'p1',
  timestamp: '2026-09-20T22:13:00.000Z',
  message: { role: 'user', content: 'investigate the limits' },
};

const notification = (taskId: string, status: string, timestamp: string) => ({
  parentUuid: 'x',
  isSidechain: false,
  type: 'attachment',
  uuid: `n-${taskId}`,
  timestamp,
  attachment: {
    type: 'queued_command',
    prompt: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>${status}</status>\n<summary>Agent finished</summary>\n<result>…</result>\n\n</task-notification>`,
    source_uuid: 's',
    commandMode: 'task-notification',
    timestamp,
  },
});

/** A subagent whose file ends on an attachment — as the real Explore's does. */
const subagent = (agentId: string) => ({
  agentId,
  meta: { agentType: 'Explore' },
  lines: [
    {
      type: 'user',
      uuid: `${agentId}-u`,
      sessionId: SESSION,
      cwd: '/home/user/project',
      agentId,
      promptId: 'p1',
      timestamp: '2026-09-20T22:13:35.000Z',
      message: { role: 'user', content: 'Local evidence for usage limits' },
    },
    { type: 'attachment', uuid: `${agentId}-a`, timestamp: '2026-09-20T22:30:35.000Z' },
  ],
});

const finishes = (events: DraftEvent[]) => events.filter((e) => e.kind === 'agent.finished');

const started = (agentId: string): DraftEvent => ({
  ts: '2026-09-20T22:13:35.000Z',
  source: 'hook',
  sessionId: SESSION,
  projectPath: '/home/user/project',
  agentId,
  parentAgentId: MAIN_AGENT_ID,
  kind: 'agent.started',
  payload: { agentType: 'Explore', spawnMode: 'async' },
});

let nextId = 0;
const stored = (draft: DraftEvent): MiranteEvent =>
  ({ ...draft, id: (nextId += 1), receivedTs: draft.ts }) as MiranteEvent;

describe('a subagent ends when Claude Code says it ended', () => {
  const parsed = parseSessionTranscript({
    mainLines: [
      prompt,
      notification(EXPLORE, 'completed', '2026-09-20T22:30:36.007Z'),
      notification(DESIGNER, 'failed', '2026-09-20T22:56:06.344Z'),
      notification('b-background-shell', 'completed', '2026-09-20T23:00:00.000Z'),
    ],
    subagents: [subagent(EXPLORE), subagent(DESIGNER)],
  });

  it("is read from the parent's task notification, with its real outcome", () => {
    const byAgent = new Map(finishes(parsed.events).map((e) => [e.agentId, e]));
    expect(byAgent.get(EXPLORE)?.payload).toMatchObject({ outcome: 'ok' });
    expect(byAgent.get(DESIGNER)?.payload).toMatchObject({ outcome: 'error' });
  });

  it('belongs to the session, although the notification entry does not say which', () => {
    for (const event of finishes(parsed.events)) expect(event.sessionId).toBe(SESSION);
  });

  it('ignores notifications about tasks that are not agents of this session', () => {
    expect(finishes(parsed.events).some((e) => e.agentId === 'b-background-shell')).toBe(false);
  });

  /**
   * SubagentStop says "ok" for every agent, the failed one included. The
   * transcript's status outranks it, in either order of arrival.
   */
  it('corrects the hook, which reports every finish as ok', () => {
    const hook = hookToEvents(
      hookPayloadSchema.parse({
        hook_event_name: 'SubagentStop',
        session_id: SESSION,
        cwd: '/home/user/project',
        agent_id: DESIGNER,
      }),
    );
    const projector = new BoardProjector();
    projector.applyAll(
      [
        ...parsed.events.filter((e) => e.kind !== 'agent.finished'),
        started(DESIGNER),
        ...hook,
        ...finishes(parsed.events),
      ].map(stored),
    );
    const designer = projector.snapshot().sessions[0]?.cards.find((c) => c.agentId === DESIGNER);
    expect(designer?.status.state).toBe('error');
  });

  it('counts each agent once however many sources report the start, and never revives it', () => {
    const projector = new BoardProjector();
    const transcriptStart = (agentId: string) => ({
      ...started(agentId),
      source: 'transcript' as const,
    });
    const hookEnd = hookToEvents(
      hookPayloadSchema.parse({
        hook_event_name: 'SubagentStop',
        session_id: SESSION,
        cwd: '/home/user/project',
        agent_id: 'y1',
      }),
    );
    projector.applyAll(
      [
        ...parsed.events.filter((e) => e.kind !== 'agent.finished'),
        started('y1'),
        ...hookEnd,
        // The transcript's report of the same start, read after the finish.
        transcriptStart('y1'),
      ].map(stored),
    );
    const cards = projector.snapshot().sessions[0]?.cards ?? [];
    expect(cards.find((c) => c.agentId === MAIN_AGENT_ID)?.runningChildren).toBe(0);
    expect(cards.find((c) => c.agentId === 'y1')?.status.state).toBe('done');
  });

  it('counts each agent against its parent once, however many sources report the end', () => {
    const projector = new BoardProjector();
    const hookEnd = (agentId: string) =>
      hookToEvents(
        hookPayloadSchema.parse({
          hook_event_name: 'SubagentStop',
          session_id: SESSION,
          cwd: '/home/user/project',
          agent_id: agentId,
        }),
      );
    projector.applyAll(
      [
        ...parsed.events.filter((e) => e.kind !== 'agent.finished'),
        started('x1'),
        started('x2'),
        started('x3'),
        ...hookEnd('x1'),
        ...hookEnd('x1').map((e) => ({ ...e, source: 'transcript' as const })),
      ].map(stored),
    );
    const main = projector.snapshot().sessions[0]?.cards.find((c) => c.agentId === MAIN_AGENT_ID);
    // Three started, one finished — reported twice. Two still running, not one.
    expect(main?.runningChildren).toBe(2);
  });
});
