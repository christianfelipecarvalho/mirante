import { describe, expect, it } from 'vitest';
import { BoardProjector, type DraftEvent, type MiranteEvent } from '@mirante/shared';
import { parseSessionTranscript } from './transcript/parse.js';
import { BRIEF_PREVIEW_LENGTH, previewProse } from '../core/redact.js';

/**
 * The instruction one agent writes for another.
 *
 * Shapes from a real session of 2026-09-22, redacted. Claude Code records the
 * brief three times: in the `Agent` tool-use input, again in the result's
 * `prompt`, and again as the first entry of the subagent's own transcript —
 * byte for byte. Mirante kept none of them. See docs/EVENT_MAP.md D13.
 */
const SESSION = 'sess-brief';
const AGENT = 'a504c1a92daec98fd';
const TURN = 'p-parent';

const BRIEF = [
  'You are the data analyst for Mirante.',
  '',
  'Answer three questions, in priority order.',
  '1. What does Claude Code record when an agent calls a subagent?',
  '2. Where do the truncations come from?',
].join('\n');

const common = {
  sessionId: SESSION,
  cwd: '/home/user/project',
  entrypoint: 'claude-vscode',
  promptId: TURN,
};

const spawnCall = {
  ...common,
  type: 'assistant',
  uuid: 'a1',
  timestamp: '2026-09-22T21:43:07.000Z',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_spawn',
        name: 'Agent',
        input: {
          description: 'Analyze agent-call capture',
          subagent_type: 'backend-architect',
          prompt: BRIEF,
          run_in_background: true,
        },
      },
    ],
  },
};

const spawnResult = {
  ...common,
  type: 'user',
  uuid: 'u2',
  parentUuid: 'a1',
  timestamp: '2026-09-22T21:43:07.900Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_spawn' }] },
  toolUseResult: {
    agentId: AGENT,
    status: 'async_launched',
    isAsync: true,
    resolvedModel: 'claude-opus-5',
    description: 'Analyze agent-call capture',
    outputFile: '/tmp/x.output',
    prompt: BRIEF,
  },
};

/** The subagent's own file opens with the brief — sidechain, no parent entry. */
const subagent = {
  agentId: AGENT,
  meta: { agentType: 'backend-architect', toolUseId: 'toolu_spawn' },
  lines: [
    {
      type: 'user',
      uuid: `${AGENT}-u1`,
      parentUuid: null,
      isSidechain: true,
      sessionId: SESSION,
      cwd: '/home/user/project',
      agentId: AGENT,
      // The brief inherits the parent turn's id — the collision that used to
      // drop it.
      promptId: TURN,
      timestamp: '2026-09-22T21:43:08.000Z',
      message: { role: 'user', content: BRIEF },
    },
  ],
};

const humanPrompt = {
  ...common,
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-09-22T21:43:00.000Z',
  message: { role: 'user', content: 'chame os especialistas' },
};

const parse = () =>
  parseSessionTranscript({
    mainLines: [humanPrompt, spawnCall, spawnResult],
    subagents: [subagent],
  });

const stored = (event: DraftEvent, index: number): MiranteEvent =>
  ({ ...event, id: index + 1, receivedTs: event.ts }) as MiranteEvent;

describe('the brief a parent writes for a subagent', () => {
  it('travels with the start, alongside the headline the caller typed', () => {
    const started = parse().events.find((e) => e.kind === 'agent.started');
    expect(started?.payload).toMatchObject({
      description: 'Analyze agent-call capture',
      agentType: 'backend-architect',
    });
    expect((started?.payload as { brief?: string }).brief).toContain(
      'What does Claude Code record',
    );
    expect((started?.payload as { briefCharCount?: number }).briefCharCount).toBe(BRIEF.length);
  });

  it('is not recorded as a request the person made', () => {
    // It carries the parent turn's promptId, so a prompt event for it collided
    // with the real request and with every sibling brief of the same turn.
    const prompts = parse().events.filter((e) => e.kind === 'prompt.submitted');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.agentId).toBe('main');
  });

  it('reaches the card, so what the agent was asked is on screen', () => {
    const projector = new BoardProjector();
    parse().events.forEach((event, index) => projector.apply(stored(event, index)));
    const card = projector
      .snapshot()
      .sessions.flatMap((s) => s.cards)
      .find((c) => c.agentId === AGENT);
    expect(card?.task).toBe('Analyze agent-call capture');
    expect(card?.brief).toContain('You are the data analyst');
    expect(card?.briefCharCount).toBe(BRIEF.length);
  });

  it('survives two agents spawned in the same turn', () => {
    const second = 'a74bba27b3e720c34';
    const { events } = parseSessionTranscript({
      mainLines: [
        humanPrompt,
        spawnCall,
        spawnResult,
        {
          ...spawnCall,
          uuid: 'a2',
          message: {
            ...spawnCall.message,
            content: [
              {
                ...spawnCall.message.content[0],
                id: 'toolu_spawn2',
                input: {
                  ...spawnCall.message.content[0]?.input,
                  description: 'Design the rows',
                  prompt: 'You are the design authority.',
                },
              },
            ],
          },
        },
        {
          ...spawnResult,
          uuid: 'u3',
          parentUuid: 'a2',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_spawn2' }],
          },
          toolUseResult: {
            ...spawnResult.toolUseResult,
            agentId: second,
            description: 'Design the rows',
            prompt: 'You are the design authority.',
          },
        },
      ],
      subagents: [subagent],
    });
    const briefs = events
      .filter((e) => e.kind === 'agent.started')
      .map((e) => (e.payload as { brief?: string }).brief);
    expect(briefs).toHaveLength(2);
    expect(briefs.every((brief) => typeof brief === 'string' && brief.length > 0)).toBe(true);
  });
});

describe('previewProse', () => {
  it('keeps the paragraphs and the list an instruction was written with', () => {
    expect(previewProse('One.\n\n\n\nTwo.\n1. Three.   Four.')).toBe(
      'One.\n\nTwo.\n1. Three. Four.',
    );
  });

  it('scrubs a secret and marks where it cut', () => {
    expect(previewProse('token sk-ant-api03-abcdefghijklmnop here')).toBe('token [redacted] here');
    const long = previewProse('a'.repeat(BRIEF_PREVIEW_LENGTH + 20));
    expect(long).toHaveLength(BRIEF_PREVIEW_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('recovering recorded assignments', () => {
  it('recovers a child-only brief without inventing another human prompt', () => {
    const text =
      'First instruction.\n\n```ts\n  preserveIndentation();\n```\n' +
      'x'.repeat(2500) +
      '\nFinal requirement.';
    const events = parseSessionTranscript({
      mainLines: [humanPrompt, spawnCall],
      subagents: [
        {
          ...subagent,
          lines: [{ ...subagent.lines[0], message: { role: 'user', content: text } }],
        },
      ],
    }).events;
    const start = events.find((event) => event.kind === 'agent.started');
    expect(start?.payload).toMatchObject({
      brief: text,
      briefAvailability: 'captured',
      briefTruncated: false,
      briefCharCount: text.length,
    });
    expect(start?.parentAgentId).toBe('main');
    expect(events.filter((event) => event.kind === 'prompt.submitted')).toHaveLength(1);
  });

  it('prefers the complete launch input over a shorter or empty result copy', () => {
    for (const prompt of ['', 'Short copy']) {
      const events = parseSessionTranscript({
        mainLines: [
          humanPrompt,
          spawnCall,
          { ...spawnResult, toolUseResult: { ...spawnResult.toolUseResult, prompt } },
        ],
      }).events;
      expect(events.find((event) => event.kind === 'agent.started')?.payload).toMatchObject({
        brief: BRIEF,
      });
    }
  });

  it('recognizes Task and gives a resumed assignment its own dedupe key', () => {
    const initial = {
      ...spawnCall,
      message: {
        ...spawnCall.message,
        content: [{ ...spawnCall.message.content[0], name: 'Task' }],
      },
    };
    const followup = {
      ...spawnCall,
      uuid: 'followup-call',
      timestamp: '2026-09-22T21:45:00.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_resume',
            name: 'Agent',
            input: { resume: AGENT, prompt: 'Continue with the final check.' },
          },
        ],
      },
    };
    const result = {
      ...spawnResult,
      uuid: 'followup-result',
      timestamp: '2026-09-22T21:45:01.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_resume' }] },
      toolUseResult: { agentId: AGENT },
    };
    const events = parseSessionTranscript({
      mainLines: [humanPrompt, initial, spawnResult, followup, result],
    }).events;
    const starts = events.filter((event) => event.kind === 'agent.started');
    expect(starts).toHaveLength(2);
    expect(starts[0]?.payload).toMatchObject({ brief: BRIEF });
    expect(starts[1]?.payload).toMatchObject({
      brief: 'Continue with the final check.',
      followUp: true,
    });
    expect(starts[1]?.dedupeKey).not.toBe(starts[0]?.dedupeKey);
    expect(
      events.some((event) => event.kind === 'tool.started' && event.payload.toolName === 'Task'),
    ).toBe(false);
  });

  it('captures SendMessage with its real recipient without reopening the agent', () => {
    const events = parseSessionTranscript({
      mainLines: [
        humanPrompt,
        spawnCall,
        spawnResult,
        {
          ...spawnCall,
          uuid: 'send',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_message',
                name: 'SendMessage',
                input: {
                  type: 'message',
                  recipient: AGENT,
                  content: 'Check this next.\n\n  Keep the indentation.',
                },
              },
            ],
          },
        },
      ],
    }).events;
    expect(events.filter((event) => event.kind === 'agent.started')).toHaveLength(1);
    const message = events.find((event) => event.kind === 'agent.instruction');
    expect(message?.agentId).toBe(AGENT);
    expect(message?.payload).toMatchObject({
      senderAgentId: 'main',
      recipientAgentId: AGENT,
      instructionType: 'message',
      availability: 'captured',
      text: 'Check this next.\n\n  Keep the indentation.',
      truncated: false,
    });
  });
});

describe('Claude delivery identity', () => {
  it('does not invent a parent assignment from a teammate envelope', () => {
    const delivered = {
      ...subagent.lines[0],
      message: {
        role: 'user',
        content:
          '<teammate-message teammate_id="peer-agent">Check the response.</teammate-message>',
      },
    };
    const events = parseSessionTranscript({
      mainLines: [humanPrompt],
      subagents: [{ agentId: AGENT, lines: [delivered] }],
    }).events;
    expect(events.some((event) => event.kind === 'agent.started')).toBe(false);
    expect(events.find((event) => event.kind === 'agent.instruction')?.payload).toMatchObject({
      senderAgentId: 'peer-agent',
      recipientAgentId: AGENT,
      instructionType: 'message',
      text: 'Check the response.',
    });
  });

  it('deduplicates an explicitly linked delivery while retaining the sending tool acknowledgement', () => {
    const send = {
      ...spawnCall,
      uuid: 'send-uuid',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'send-id',
            name: 'SendMessage',
            input: { type: 'broadcast', content: 'Check the response.' },
          },
        ],
      },
    };
    const ack = {
      ...spawnResult,
      sourceToolAssistantUUID: 'send-uuid',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'send-id' }] },
      toolUseResult: { success: true },
    };
    const delivered = {
      ...subagent.lines[0],
      parentUuid: 'previous',
      sourceToolAssistantUUID: 'send-uuid',
      message: {
        role: 'user',
        content: '<teammate-message teammate_id="main">Check the response.</teammate-message>',
      },
    };
    const events = parseSessionTranscript({
      mainLines: [humanPrompt, spawnCall, spawnResult, send, ack],
      subagents: [{ ...subagent, lines: [...subagent.lines, delivered] }],
    }).events;
    expect(events.filter((event) => event.kind === 'agent.instruction')).toHaveLength(1);
    expect(
      events.some(
        (event) => event.kind === 'tool.finished' && event.payload.toolUseId === 'send-id',
      ),
    ).toBe(true);
  });

  it('does not assume that an unlinked later user entry was sent by the parent', () => {
    const delivered = {
      ...subagent.lines[0],
      uuid: 'later-user',
      parentUuid: 'previous',
      message: { role: 'user', content: 'A separately recorded follow-up.' },
    };
    const events = parseSessionTranscript({
      mainLines: [humanPrompt, spawnCall, spawnResult],
      subagents: [{ ...subagent, lines: [...subagent.lines, delivered] }],
    }).events;
    expect(events.find((event) => event.kind === 'agent.instruction')?.payload).toMatchObject({
      senderAgentId: 'unknown',
      recipientAgentId: AGENT,
      text: 'A separately recorded follow-up.',
    });
  });
});
