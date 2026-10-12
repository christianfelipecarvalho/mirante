import { describe, expect, it } from 'vitest';
import { BoardProjector, MAIN_AGENT_ID, type DraftEvent, type MiranteEvent } from '@mirante/shared';
import { hookPayloadSchema, hookToEvents } from './hooks.js';
import { parseSessionTranscript } from './transcript/parse.js';
import { BRIEF_PREVIEW_LENGTH } from '../core/redact.js';

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

describe('the completed agent response', () => {
  const agentCall = {
    ...prompt,
    type: 'assistant',
    uuid: 'spawn-message',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'spawn', name: 'Agent', input: { prompt: 'Assigned work' } },
      ],
    },
  };
  const nativeResult = (status: string) => ({
    ...prompt,
    timestamp: '2026-09-20T22:14:00.000Z',
    uuid: 'spawn-result',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'spawn' }] },
    toolUseResult: {
      agentId: EXPLORE,
      status,
      content: [{ type: 'text', text: 'Finished review.\n\nContact person@example.com.' }],
    },
  });
  it('captures a confirmed synchronous AgentOutput response even without the child file', () => {
    const ended = finishes(
      parseSessionTranscript({ mainLines: [prompt, agentCall, nativeResult('completed')] }).events,
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      agentId: EXPLORE,
      correlationId: 'spawn',
      payload: {
        outcome: 'ok',
        assignmentId: 'spawn',
        resultAvailability: 'captured',
        resultTruncated: false,
        resultPreview: 'Finished review.\n\nContact [redacted].',
      },
    });
  });

  it('does not describe an async launch as a completed response', () => {
    expect(
      finishes(
        parseSessionTranscript({ mainLines: [prompt, agentCall, nativeResult('async_launched')] })
          .events,
      ),
    ).toEqual([]);
  });

  it('captures only a terminal end_turn answer and keeps paragraphs, redaction and explicit truncation', () => {
    const text = `Final answer.\n\nUse sk-ant-secret1234567.\n${'x'.repeat(BRIEF_PREVIEW_LENGTH)}`;
    const child = subagent(EXPLORE);
    const ended = finishes(
      parseSessionTranscript({
        mainLines: [prompt],
        subagents: [
          {
            ...child,
            lines: [
              child.lines[0],
              {
                ...prompt,
                type: 'assistant',
                timestamp: '2026-09-20T22:14:00.000Z',
                message: {
                  role: 'assistant',
                  stop_reason: 'end_turn',
                  content: [{ type: 'text', text }],
                },
              },
            ],
          },
        ],
      }).events,
    );
    expect(ended[0]?.payload).toMatchObject({
      resultAvailability: 'captured',
      resultTruncated: true,
      resultCharCount: text.length,
    });
    const response = ended[0]?.payload.resultPreview;
    expect(response?.length).toBe(BRIEF_PREVIEW_LENGTH);
    expect(response).toContain('Final answer.\n\nUse [redacted].');
    expect(response?.endsWith('…')).toBe(true);
  });

  it('reads the actual result tag of a native task notification', () => {
    const note = notification(EXPLORE, 'completed', '2026-09-20T22:15:00.000Z');
    note.attachment.prompt = note.attachment.prompt.replace(
      '<result>…</result>',
      '<result>Review complete. Contact person@example.com.</result>',
    );
    const ended = finishes(
      parseSessionTranscript({ mainLines: [prompt, note], subagents: [subagent(EXPLORE)] }).events,
    );
    expect(ended[0]?.payload).toMatchObject({
      resultAvailability: 'captured',
      resultPreview: 'Review complete. Contact [redacted].',
    });
  });

  it('does not label an intermediate narrative as the result when completion contains no answer', () => {
    const note = notification(EXPLORE, 'completed', '2026-09-20T22:15:00.000Z');
    note.attachment.prompt = note.attachment.prompt.replace('<result>…</result>', '');
    const child = subagent(EXPLORE);
    const ended = finishes(
      parseSessionTranscript({
        mainLines: [prompt, note],
        subagents: [
          {
            ...child,
            lines: [
              child.lines[0],
              {
                ...prompt,
                type: 'assistant',
                timestamp: '2026-09-20T22:14:00.000Z',
                message: {
                  role: 'assistant',
                  stop_reason: 'tool_use',
                  content: [{ type: 'text', text: 'I will inspect the code now.' }],
                },
              },
            ],
          },
        ],
      }).events,
    );
    expect(ended[0]?.payload).toMatchObject({ resultAvailability: 'missing' });
    expect(ended[0]?.payload.resultPreview).toBeUndefined();
  });

  it('keeps encrypted result availability without persisting ciphertext', () => {
    const native = nativeResult('completed');
    native.toolUseResult.content = [{ type: 'text', text: 'gAAAAencrypted_token_here=' }];
    const ended = finishes(
      parseSessionTranscript({ mainLines: [prompt, agentCall, native] }).events,
    );
    expect(ended[0]?.payload).toMatchObject({ resultAvailability: 'encrypted' });
    expect(ended[0]?.payload.resultPreview).toBeUndefined();
  });

  it('captures the final assistant response carried by SubagentStop', () => {
    const ended = finishes(
      hookToEvents(
        hookPayloadSchema.parse({
          hook_event_name: 'SubagentStop',
          session_id: SESSION,
          cwd: '/tmp/project',
          agent_id: EXPLORE,
          last_assistant_message: 'Completed. Contact person@example.com.',
        }),
      ),
    );
    expect(ended[0]?.payload).toMatchObject({
      resultAvailability: 'captured',
      resultTruncated: false,
      resultPreview: 'Completed. Contact [redacted].',
    });
  });
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
