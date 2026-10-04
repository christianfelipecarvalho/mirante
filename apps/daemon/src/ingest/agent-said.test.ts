import { describe, expect, it } from 'vitest';
import { BoardProjector, MAIN_AGENT_ID, type DraftEvent, type MiranteEvent } from '@mirante/shared';
import { parseSessionTranscript } from './transcript/parse.js';
import { SAID_PREVIEW_LENGTH } from '../core/redact.js';

/**
 * What an agent writes between its tool calls.
 *
 * Shapes taken from a real VS Code session: an assistant entry carries the
 * prose and the tool call it announces in the same message, in that order, and
 * the thinking block that precedes them both is empty — Claude Code writes its
 * signature and nothing else, which is why the board can show what an agent
 * said but never what it thought. See docs/EVENT_MAP.md D12.
 */
const common = {
  sessionId: 'sess-said',
  cwd: '/home/user/project',
  version: '2.1.278',
  entrypoint: 'claude-vscode',
  promptId: 'p1',
};

const assistant = (uuid: string, content: unknown[], timestamp = '2026-09-21T10:00:01.000Z') => ({
  ...common,
  type: 'assistant',
  uuid,
  parentUuid: 'u1',
  timestamp,
  message: { role: 'assistant', model: 'claude-opus-5', content },
});

const saidOf = (events: DraftEvent[]) =>
  events.filter((event) => event.kind === 'agent.said') as Extract<
    DraftEvent,
    { kind: 'agent.said' }
  >[];

const stored = (event: DraftEvent, index: number): MiranteEvent =>
  ({ ...event, id: index + 1, receivedTs: event.ts }) as MiranteEvent;

describe('an agent speaking', () => {
  it('records the prose before the tool call it announces', () => {
    const { events } = parseSessionTranscript({
      mainLines: [
        assistant('a1', [
          { type: 'thinking', thinking: '', signature: 'AbC…' },
          { type: 'text', text: 'Vou medir o tamanho disso antes de responder.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'wc -l *.ts' } },
        ]),
      ],
    });

    const kinds = events.filter((e) => e.kind === 'agent.said' || e.kind === 'tool.started');
    expect(kinds.map((e) => e.kind)).toEqual(['agent.said', 'tool.started']);
    expect(saidOf(events)[0]?.payload.text).toBe('Vou medir o tamanho disso antes de responder.');
  });

  it('says nothing for a thinking block, which reaches the transcript empty', () => {
    const { events } = parseSessionTranscript({
      mainLines: [assistant('a1', [{ type: 'thinking', thinking: '', signature: 'AbC…' }])],
    });
    expect(saidOf(events)).toEqual([]);
  });

  it('keeps two passages of one message apart', () => {
    const { events } = parseSessionTranscript({
      mainLines: [
        assistant('a1', [
          { type: 'text', text: 'Primeiro isso.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'text', text: 'Agora aquilo.' },
        ]),
      ],
    });
    const said = saidOf(events);
    expect(said.map((e) => e.payload.text)).toEqual(['Primeiro isso.', 'Agora aquilo.']);
    // Re-reading the same file must not double the board's rows.
    expect(new Set(said.map((e) => e.dedupeKey)).size).toBe(2);
    const again = saidOf(
      parseSessionTranscript({
        mainLines: [
          assistant('a1', [
            { type: 'text', text: 'Primeiro isso.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } },
            { type: 'text', text: 'Agora aquilo.' },
          ]),
        ],
      }).events,
    );
    expect(again.map((e) => e.dedupeKey)).toEqual(said.map((e) => e.dedupeKey));
  });

  it('scrubs a secret the agent happened to quote', () => {
    const { events } = parseSessionTranscript({
      mainLines: [
        assistant('a1', [
          { type: 'text', text: 'O token é sk-ant-api03-abcdefghijklmnop, vou usar ele.' },
        ]),
      ],
    });
    expect(saidOf(events)[0]?.payload.text).toBe('O token é [redacted], vou usar ele.');
  });

  it('marks a long passage as cut rather than storing all of it', () => {
    const long = 'a'.repeat(SAID_PREVIEW_LENGTH + 50);
    const { events } = parseSessionTranscript({
      mainLines: [assistant('a1', [{ type: 'text', text: long }])],
    });
    const said = saidOf(events)[0];
    expect(said?.payload.truncated).toBe(true);
    expect(said?.payload.text.length).toBe(SAID_PREVIEW_LENGTH);
  });

  it('puts the sentence on the card, and hands the line back to the next tool', () => {
    const { events } = parseSessionTranscript({
      mainLines: [
        assistant('a1', [{ type: 'text', text: 'Vou rodar os testes.' }]),
        assistant('a2', [
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } },
        ]),
      ],
    });

    const projector = new BoardProjector();
    // The board as it stands the moment the agent finishes its sentence, before
    // the tool call in the next entry lands.
    const afterSaying = new BoardProjector();
    events
      .slice(0, events.findIndex((event) => event.kind === 'agent.said') + 1)
      .forEach((event, index) => afterSaying.apply(stored(event, index)));
    const spoken = afterSaying
      .snapshot()
      .sessions.flatMap((s) => s.cards)
      .find((c) => c.agentId === MAIN_AGENT_ID);
    expect(spoken?.lastActivity).toBe('Vou rodar os testes.');
    expect(spoken?.lastActivityKind).toBe('said');
    // Talking is not doing: nothing is claimed to be running.
    expect(spoken?.activity).toBeUndefined();

    events.forEach((event, index) => projector.apply(stored(event, index)));
    const card = projector
      .snapshot()
      .sessions.flatMap((s) => s.cards)
      .find((c) => c.agentId === MAIN_AGENT_ID);
    expect(card?.activity).toBe('Bash: pnpm test');
    expect(card?.lastActivityKind).toBeUndefined();
  });

  it('gives the sentence a row of its own in the timeline', () => {
    const { events } = parseSessionTranscript({
      mainLines: [assistant('a1', [{ type: 'text', text: 'Pronto, subi o daemon.' }])],
    });
    const projector = new BoardProjector();
    events.forEach((event, index) => projector.apply(stored(event, index)));
    const row = projector.snapshot().timeline.find((entry) => entry.kind === 'said');
    expect(row?.text).toBe('Pronto, subi o daemon.');
  });
});
