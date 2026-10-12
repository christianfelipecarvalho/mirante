import { describe, expect, it } from 'vitest';
import { BoardProjector, type DraftEvent, type MiranteEvent } from '@mirante/shared';
import { createThreadState, parseRolloutLines } from './parse.js';
import { captureInstruction, BRIEF_PREVIEW_LENGTH } from '../../core/redact.js';

const root = '01a0b4a4-e6d8-76f2-aad9-a3383586f8a3';
const child = '01a0b4da-719b-72b3-b5c6-ec480fe56c59';
const turn = '01a0b4da-7999-72b3-b5c6-ec480fe56c59';
const ts = '2026-09-22T12:00:00.000Z';
const meta = {
  type: 'session_meta',
  timestamp: ts,
  payload: {
    id: child,
    session_id: root,
    parent_thread_id: root,
    thread_source: 'subagent',
    agent_path: '/root/check',
    cwd: '/tmp/test',
  },
};
const started = (id = turn) => ({
  type: 'event_msg',
  timestamp: ts,
  payload: { type: 'task_started', turn_id: id },
});
const delivered = (kind: string, text: string, id = 'message-1') => ({
  type: 'response_item',
  timestamp: ts,
  payload: {
    type: 'agent_message',
    id,
    author: '/root',
    recipient: '/root/check',
    content: [
      {
        type: 'input_text',
        text: `Message Type: ${kind}\nTask name: /root/check\nSender: /root\nPayload:\n${text}`,
      },
    ],
  },
});
const stored = (events: DraftEvent[]) =>
  events.map((event, index) => ({ ...event, id: index + 1, receivedTs: ts }) as MiranteEvent);

describe('delivered Codex instructions', () => {
  it('recovers a NEW_TASK after the start in a later tail batch, without counting another child', () => {
    const state = createThreadState();
    const first = parseRolloutLines(state, [meta, started()]).events;
    const next = parseRolloutLines(state, [
      delivered('NEW_TASK', 'Do the work.\n\n  Keep this indented.'),
    ]).events;
    const start = first.find((event) => event.kind === 'agent.started')!;
    const enriched = next.find((event) => event.kind === 'agent.started')!;
    expect(enriched.dedupeKey).toBe(start.dedupeKey);
    expect(enriched.ts).toBe(start.ts);
    expect(enriched.payload).toMatchObject({
      briefAvailability: 'captured',
      brief: 'Do the work.\n\n  Keep this indented.',
      briefTruncated: false,
    });
    expect(next.some((event) => event.kind === 'prompt.submitted')).toBe(false);
    const projector = new BoardProjector();
    projector.applyAll(stored([...first, ...next]));
    expect(
      projector.snapshot().sessions[0]?.cards.find((card) => card.agentId === 'main')
        ?.runningChildren,
    ).toBe(1);
  });

  it('keeps messages out of lifecycle and enriches each follow-up separately', () => {
    const state = createThreadState();
    const first = parseRolloutLines(state, [
      meta,
      started(),
      delivered('NEW_TASK', 'Initial instruction.'),
    ]).events;
    const message = parseRolloutLines(state, [
      delivered('MESSAGE', 'Additional constraint.', 'message-2'),
    ]).events;
    expect(message).toHaveLength(1);
    expect(message[0]).toMatchObject({
      kind: 'agent.instruction',
      agentId: child,
      payload: {
        senderAgentId: 'main',
        recipientAgentId: child,
        instructionType: 'message',
        text: 'Additional constraint.',
      },
    });
    const followup = parseRolloutLines(state, [
      started('01a0b4db-7999-72b3-b5c6-ec480fe56c59'),
      delivered('NEW_TASK', 'A different assignment.', 'message-3'),
    ]).events;
    const enriched = followup.filter((event) => event.kind === 'agent.started').at(-1)!;
    expect(enriched.payload).toMatchObject({ followUp: true, brief: 'A different assignment.' });
    expect(enriched.dedupeKey).not.toBe(
      first.find((event) => event.kind === 'agent.started')?.dedupeKey,
    );
    expect(parseRolloutLines(state, [delivered('FINAL_ANSWER', 'The return.')]).events).toEqual([]);
  });

  it('does not treat inherited history as this child’s instruction', () => {
    const state = createThreadState();
    const events = parseRolloutLines(state, [
      meta,
      started('01a0b4a4-e828-78d2-a3df-04d31ddd12ff'),
      delivered('NEW_TASK', 'Inherited request.'),
      started(),
      delivered('NEW_TASK', 'Own request.'),
    ]).events;
    expect(JSON.stringify(events)).not.toContain('Inherited request');
    expect(JSON.stringify(events)).toContain('Own request');
  });

  it('exposes ciphertext availability without persisting the ciphertext', () => {
    const encrypted = `gAAAA${'x'.repeat(200)}`;
    const state = createThreadState();
    const events = parseRolloutLines(state, [
      meta,
      started(),
      delivered('NEW_TASK', encrypted),
    ]).events;
    expect(events.filter((event) => event.kind === 'agent.started').at(-1)?.payload).toMatchObject({
      briefAvailability: 'encrypted',
    });
    expect(JSON.stringify(events)).not.toContain('gAAAA');
  });
});

describe('instruction text preservation', () => {
  it('redacts before storing, preserves layout, and does not confuse redaction with truncation', () => {
    const text =
      'Review:\r\n\r\n```ts\r\n  const credential = "sk-ant-api03-abcdefghijklmnop";\r\n```';
    const captured = captureInstruction(text);
    expect(captured.text).toContain('\n\n```ts\n  const credential');
    expect(captured.text).toContain('[redacted]');
    expect(captured.text).not.toContain('sk-ant');
    expect(captured.truncated).toBe(false);
    expect(captured.charCount).toBe(text.length);
    expect(captureInstruction('x'.repeat(BRIEF_PREVIEW_LENGTH + 10))).toMatchObject({
      truncated: true,
      charCount: BRIEF_PREVIEW_LENGTH + 10,
    });
    expect(captureInstruction('x'.repeat(BRIEF_PREVIEW_LENGTH + 10)).text).toHaveLength(
      BRIEF_PREVIEW_LENGTH,
    );
  });
});
