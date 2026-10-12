import { describe, expect, it } from 'vitest';
import {
  dedupeKeys,
  emptyTokenUsage,
  type AgentCard,
  type MiranteEvent,
  type SessionLane,
} from '@mirante/shared';
import { agentMapInstruction } from './agent-map-instruction.js';

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 11, 10, 0, seconds)).toISOString();
const card = (extra: Partial<AgentCard> = {}): AgentCard => ({
  sessionId: 's1',
  agentId: 'child',
  parentAgentId: 'main',
  startedAt: at(0),
  status: { state: 'thinking' },
  tokens: emptyTokenUsage(),
  runningChildren: 0,
  ...extra,
});
const lane: SessionLane = {
  sessionId: 's1',
  projectPath: '/tmp/project',
  projectName: 'project',
  entrypoint: 'cli',
  harness: 'claude-code',
  startedAt: at(0),
  tokens: emptyTokenUsage(),
  cards: [],
};
let nextId = 0;
const event = (
  partial: Partial<MiranteEvent> & Pick<MiranteEvent, 'kind' | 'payload'>,
): MiranteEvent =>
  ({
    id: ++nextId,
    ts: at(1),
    receivedTs: at(50),
    source: 'transcript',
    sessionId: 's1',
    projectPath: '/tmp/project',
    agentId: 'child',
    parentAgentId: 'main',
    ...partial,
  }) as MiranteEvent;
const assignment = (
  text?: string,
  extra: Partial<Omit<Extract<MiranteEvent, { kind: 'agent.started' }>, 'kind'>> = {},
) =>
  event({
    kind: 'agent.started',
    dedupeKey: dedupeKeys.agentStarted('child'),
    payload: {
      agentType: 'reviewer',
      spawnMode: 'async',
      briefAvailability: text ? 'captured' : 'missing',
      ...(text ? { brief: text, briefCharCount: text.length, briefTruncated: false } : {}),
    },
    ...extra,
  });
const prompt = (
  text: string,
  extra: Partial<Omit<Extract<MiranteEvent, { kind: 'prompt.submitted' }>, 'kind'>> = {},
) =>
  event({
    agentId: 'main',
    parentAgentId: undefined,
    kind: 'prompt.submitted',
    payload: { preview: text, charCount: text.length },
    ...extra,
  });
const main = card({ agentId: 'main', parentAgentId: undefined });

describe('real instructions in the compact agent map', () => {
  it('uses the current projected brief, with its paragraphs and capture metadata', () => {
    const brief = 'Review the boundary.\n\n  Preserve [REDACTED] and the API.\nFinal requirement…';
    const result = agentMapInstruction(
      lane,
      card({ brief, briefAvailability: 'captured', briefCharCount: 70_000, briefTruncated: true }),
      [assignment('An older, unrelated task.')],
    );
    expect(result).toEqual({
      text: brief,
      availability: 'captured',
      charCount: 70_000,
      truncated: true,
    });
  });

  it('does not reconstruct an instruction from a title, activity, answer or parent prompt', () => {
    const result = agentMapInstruction(
      lane,
      card({ task: 'Designer', activity: 'Read app.ts', lastActivity: 'Finished the review' }),
      [
        prompt('Parent request.'),
        event({ kind: 'agent.said', payload: { text: 'A report, not an assignment.' } }),
        event({
          kind: 'prompt.submitted',
          payload: { preview: 'Legacy inherited history.', charCount: 25 },
        }),
      ],
    );
    expect(result.text).toBeUndefined();
    expect(result.availability).toBe('missing');
  });

  it.each(['missing', 'encrypted'] as const)(
    'preserves projected %s when no instruction exists',
    (availability) => {
      const result = agentMapInstruction(lane, card({ briefAvailability: availability }), []);
      expect(result.text).toBeUndefined();
      expect(result.availability).toBe(availability);
    },
  );

  it('isolates session and recipient identities even when their dedupe keys collide', () => {
    const result = agentMapInstruction(lane, card(), [
      assignment('This agent’s instruction.'),
      assignment('Another session’s private instruction.', { sessionId: 's2', ts: at(10) }),
      assignment('Another agent’s private instruction.', { agentId: 'other', ts: at(11) }),
    ]);
    expect(result.text).toBe('This agent’s instruction.');
  });

  it('rejects a card from a different session, including its projected text', () => {
    expect(
      agentMapInstruction(lane, card({ sessionId: 's2', brief: 'Private instruction.' }), []),
    ).toEqual({
      availability: 'missing',
    });
  });

  it.each(['message', 'broadcast'] as const)(
    'never treats a %s as a replacement prompt',
    (instructionType) => {
      const result = agentMapInstruction(lane, card(), [
        assignment('The actual assignment.'),
        event({
          kind: 'agent.instruction',
          ts: at(20),
          payload: {
            senderAgentId: 'main',
            recipientAgentId: 'child',
            instructionType,
            availability: 'captured',
            text: 'Coordination message.',
          },
        }),
      ]);
      expect(result.text).toBe('The actual assignment.');
    },
  );

  it('uses a targeted follow-up delivered by a different sender, without using its activity agent id', () => {
    const result = agentMapInstruction(lane, card(), [
      assignment('Initial assignment.'),
      event({
        kind: 'agent.instruction',
        agentId: 'parent',
        ts: at(10),
        payload: {
          senderAgentId: 'parent',
          recipientAgentId: 'child',
          instructionType: 'followup',
          availability: 'captured',
          text: 'Now validate the complete output…',
          charCount: 80_000,
          truncated: true,
        },
      }),
      event({
        kind: 'agent.instruction',
        ts: at(20),
        payload: {
          senderAgentId: 'child',
          recipientAgentId: 'other',
          instructionType: 'assignment',
          availability: 'captured',
          text: 'Outgoing child task.',
        },
      }),
    ]);
    expect(result).toEqual({
      text: 'Now validate the complete output…',
      availability: 'captured',
      charCount: 80_000,
      truncated: true,
    });
  });

  it.each(['missing', 'encrypted'] as const)(
    'keeps the latest %s follow-up instead of reviving an old prompt',
    (availability) => {
      const result = agentMapInstruction(lane, card(), [
        assignment('Old captured prompt.'),
        assignment(undefined, {
          ts: at(20),
          dedupeKey: dedupeKeys.agentFollowUp('child', 'second'),
          payload: {
            agentType: 'reviewer',
            spawnMode: 'async',
            followUp: true,
            briefAvailability: availability,
          },
        }),
      ]);
      expect(result.text).toBeUndefined();
      expect(result.availability).toBe(availability);
    },
  );

  it('uses event time instead of arrival order for repaired assignments', () => {
    const result = agentMapInstruction(lane, card(), [
      assignment('Current assignment.', {
        ts: at(20),
        dedupeKey: dedupeKeys.agentFollowUp('child', 'current'),
      }),
      assignment('An old assignment read later.', { ts: at(1) }),
    ]);
    expect(result.text).toBe('Current assignment.');
  });

  it('does not reuse an earlier captured assignment when current history is unavailable', () => {
    const result = agentMapInstruction(
      lane,
      card({ startedAt: at(20), briefAvailability: 'encrypted' }),
      [assignment('A task that ended before the current one.', { ts: at(1) })],
    );
    expect(result.text).toBeUndefined();
    expect(result.availability).toBe('encrypted');
  });

  it('accepts a richer repair of the same assignment followed by sparse rereads', () => {
    const result = agentMapInstruction(lane, card(), [
      assignment(),
      assignment('Recovered complete instruction.'),
      assignment(),
    ]);
    expect(result.text).toBe('Recovered complete instruction.');
    expect(result.availability).toBe('captured');
  });
});

describe('the main agent’s recorded request', () => {
  it('shows a substantive request while later short answers continue its work', () => {
    const result = agentMapInstruction(lane, main, [
      prompt('Make the header easier to read.', { promptId: 'p1', ts: at(1) }),
      prompt('Continue', { promptId: 'p2', ts: at(5) }),
      prompt('sim', { promptId: 'p3', ts: at(10) }),
    ]);
    expect(result.text).toBe('Make the header easier to read.');
    expect(result.charCount).toBe('Make the header easier to read.'.length);
  });

  it('retains the real request when multiple messages share one native prompt id', () => {
    const result = agentMapInstruction(lane, main, [
      prompt('Fix the build.', { promptId: 'p1', ts: at(1) }),
      prompt('ok', { promptId: 'p1', ts: at(5) }),
    ]);
    expect(result.text).toBe('Fix the build.');
  });

  it('does not misclassify a brief substantive request as permission to continue', () => {
    const result = agentMapInstruction(lane, main, [
      prompt('Make the header easier to read.', { ts: at(1) }),
      prompt('fix the build', { ts: at(5) }),
    ]);
    expect(result.text).toBe('fix the build');
  });

  it('keeps an actual continuation when no earlier substantive request was captured', () => {
    expect(agentMapInstruction(lane, main, [prompt('Continue')]).text).toBe('Continue');
  });

  it('ignores other sessions, child prompts, inherited child history and injected machine messages', () => {
    const result = agentMapInstruction(lane, main, [
      prompt('The human request.', { ts: at(1) }),
      prompt('Another session’s secret.', { sessionId: 's2', ts: at(5) }),
      prompt('Child’s assignment.', { agentId: 'child', ts: at(6) }),
      prompt('Inherited child history.', { parentAgentId: 'parent', ts: at(7) }),
      prompt('<agent-message from="child">A hand-back.', { ts: at(8) }),
      prompt('<system-reminder>A system note.', { ts: at(9) }),
      prompt('<task-notification>A completed task.', { ts: at(10) }),
    ]);
    expect(result.text).toBe('The human request.');
  });

  it('strips editor context without marking a shorter redacted request as truncated', () => {
    const preview = '<ide_opened_file>/private/context.env</ide_opened_file> Fix [REDACTED].';
    const result = agentMapInstruction(lane, main, [
      prompt(preview, { payload: { preview, charCount: 150 } }),
    ]);
    expect(result).toEqual({
      text: 'Fix [REDACTED].',
      availability: 'captured',
      charCount: 150,
      truncated: false,
    });
  });

  it('preserves the source’s original count and actual cut marker', () => {
    const preview = 'Investigate the complete problem…';
    const result = agentMapInstruction(lane, main, [
      prompt(preview, { payload: { preview, charCount: 4_000 } }),
    ]);
    expect(result).toEqual({
      text: preview,
      availability: 'captured',
      charCount: 4_000,
      truncated: true,
    });
  });

  it.each([false, true])(
    'uses the better source for a duplicate prompt, reversed=%s',
    (reverse) => {
      const observed = [
        prompt('Hook preview.', { source: 'hook', dedupeKey: 'same-fact' }),
        prompt('The transcript’s complete recorded preview.', {
          source: 'transcript',
          dedupeKey: 'same-fact',
        }),
      ];
      if (reverse) observed.reverse();
      expect(agentMapInstruction(lane, main, observed).text).toBe(
        'The transcript’s complete recorded preview.',
      );
    },
  );

  it('does not let a late backfill replace a newer request', () => {
    const result = agentMapInstruction(lane, main, [
      prompt('Current request.', { ts: at(20) }),
      prompt('An older request read later.', { ts: at(1) }),
    ]);
    expect(result.text).toBe('Current request.');
  });

  it('returns missing when only unavailable context or machine chatter was recorded', () => {
    const result = agentMapInstruction(
      lane,
      {
        ...main,
        activity: 'Running tools.',
        lastActivityKind: 'prompt',
        lastActivity: 'Unverified text.',
      },
      [
        prompt('<ide_opened_file>Truncated editor context'),
        prompt('<system-reminder>Only a reminder.'),
      ],
    );
    expect(result).toEqual({ availability: 'missing' });
  });

  it('accepts readonly history without changing its order, text, cards or lane', () => {
    const observed = Object.freeze([
      Object.freeze(prompt('New request.', { ts: at(20) })),
      Object.freeze(prompt('Old request.', { ts: at(1) })),
    ]);
    const selectedCard = Object.freeze({ ...main });
    const selectedLane = Object.freeze({ ...lane });
    const before = JSON.stringify([observed, selectedCard, selectedLane]);
    expect(agentMapInstruction(selectedLane, selectedCard, observed).text).toBe('New request.');
    expect(JSON.stringify([observed, selectedCard, selectedLane])).toBe(before);
  });
});
