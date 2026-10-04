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
