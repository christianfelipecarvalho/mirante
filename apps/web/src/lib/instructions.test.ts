import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { dedupeKeys, type MiranteEvent } from '@mirante/shared';
import { I18nProvider } from './i18n.js';
import { buildSteps, groupStepsByTurn, type Step } from './steps.js';

// These markup tests use a settled local reading. Async language changes,
// shared requests and the actual model are validated separately.
const translations = vi.hoisted(() => ({ target: 'en', values: new Map<string, string>() }));
vi.mock('./use-instruction-translation', () => ({
  useVisibleInstruction: () => ({ ref: { current: null }, visible: true }),
  useInstructionTranslation: (text?: string) => ({
    target: translations.target,
    loading: false,
    retry: vi.fn(),
    value: text
      ? {
          ok: true,
          text: translations.values.get(text) ?? text,
          sourceLanguage: 'en',
          translated: translations.values.has(text),
        }
      : undefined,
  }),
}));

let id = 0;
const event = (partial: Partial<MiranteEvent> & Pick<MiranteEvent, 'kind' | 'payload'>) =>
  ({
    id: ++id,
    ts: '2026-10-10T10:00:00.000Z',
    receivedTs: '2026-10-10T10:00:01.000Z',
    source: 'transcript',
    sessionId: 's1',
    projectPath: '/tmp/project',
    agentId: 'child',
    parentAgentId: 'main',
    ...partial,
  }) as MiranteEvent;

const assignment = (text?: string, partial: Partial<Omit<MiranteEvent, 'kind' | 'payload'>> = {}) =>
  event({
    kind: 'agent.started',
    dedupeKey: dedupeKeys.agentStarted('child'),
    promptId: 'parent-turn',
    payload: {
      agentType: 'reviewer',
      spawnMode: 'async',
      briefAvailability: text ? 'captured' : 'missing',
      ...(text ? { brief: text, briefCharCount: text.length, briefTruncated: false } : {}),
    },
    ...partial,
  });

const filter = { sessionId: 's1', agentId: 'child' };
const grouped = (events: MiranteEvent[]) => groupStepsByTurn(buildSteps(events, filter), 'child');

describe('instructions in a filtered subagent activity', () => {
  it('retains the actual assignment when the parent prompt is filtered out', () => {
    const [group] = grouped([
      event({
        agentId: 'main',
        kind: 'prompt.submitted',
        promptId: 'parent-turn',
        payload: { preview: 'Review both areas', charCount: 17 },
      }),
      assignment('Review the backend\n  Preserve the API contract.'),
    ]);
    expect(group?.prompt).toBeUndefined();
    expect(group?.origin).toBe('delegation');
    expect(group?.instruction?.detail).toBe('Review the backend\n  Preserve the API contract.');
    expect(group?.instruction?.instruction).toMatchObject({
      senderAgentId: 'main',
      recipientAgentId: 'child',
    });
  });

  it('inherits the most recent assignment for the child’s separate native turn', () => {
    const groups = grouped([
      assignment('First task'),
      event({
        kind: 'agent.started',
        dedupeKey: dedupeKeys.agentFollowUp('child', 'second'),
        promptId: 'next-parent-turn',
        ts: '2026-10-10T10:05:00.000Z',
        payload: {
          agentType: 'reviewer',
          spawnMode: 'async',
          followUp: true,
          brief: 'Second task',
        },
      }),
      event({
        kind: 'tool.started',
        promptId: 'child-native-turn',
        ts: '2026-10-10T10:05:02.000Z',
        payload: { toolUseId: 'tool', toolName: 'Read', summary: '/tmp/app.ts' },
      }),
      event({
        kind: 'agent.instruction',
        promptId: 'child-native-turn',
        ts: '2026-10-10T10:05:03.000Z',
        payload: {
          senderAgentId: 'main',
          recipientAgentId: 'child',
          instructionType: 'message',
          availability: 'captured',
          text: 'One more detail',
        },
      }),
    ]);
    expect(groups[0]?.instruction?.detail).toBe('Second task');
    expect(groups[0]?.promptId).toBe('child-native-turn');
  });

  it('uses richer same-source re-reads and keeps captured text on a sparse later report', () => {
    const steps = buildSteps(
      [assignment(), assignment('Recovered assignment'), assignment()],
      filter,
    );
    const instructions = steps.filter((step) => step.kind === 'instruction');
    expect(instructions).toHaveLength(1);
    expect(instructions[0]?.detail).toBe('Recovered assignment');
    expect(instructions[0]?.instruction?.availability).toBe('captured');
    expect(steps.filter((step) => step.verb === 'spawned')).toHaveLength(1);
  });

  it('does not let a weaker source replace transcript text', () => {
    const [group] = grouped([
      assignment('Recorded instruction'),
      assignment('Partial hook', { source: 'hook' }),
    ]);
    expect(group?.instruction?.detail).toBe('Recorded instruction');
  });

  it('keeps the human prompt as the session header while showing each delegated instruction', () => {
    const events = [
      event({
        agentId: 'main',
        kind: 'prompt.submitted',
        promptId: 'parent-turn',
        payload: { preview: 'Review both areas', charCount: 17 },
      }),
      assignment('Backend assignment'),
      assignment('Frontend assignment', {
        agentId: 'sibling',
        dedupeKey: dedupeKeys.agentStarted('sibling'),
      }),
    ];
    const [group] = groupStepsByTurn(buildSteps(events, { sessionId: 's1' }));
    expect(group?.prompt).toBe('Review both areas');
    expect(group?.instruction).toBeUndefined();
    expect(
      group?.steps
        .filter((step) => step.kind === 'instruction')
        .map((step) => step.detail)
        .sort(),
    ).toEqual(['Backend assignment', 'Frontend assignment']);
  });

  it('does not label a mixed sibling turn with one arbitrary assignment', () => {
    const [group] = groupStepsByTurn(
      buildSteps(
        [
          assignment('Backend assignment'),
          assignment('Frontend assignment', {
            agentId: 'sibling',
            dedupeKey: dedupeKeys.agentStarted('sibling'),
          }),
        ],
        { sessionId: 's1' },
      ),
    );
    expect(group?.instruction).toBeUndefined();
    expect(group?.origin).toBe('delegation');
  });

  it('shows incoming and outgoing messages once in each relevant agent filter', () => {
    const message = event({
      kind: 'agent.instruction',
      dedupeKey: dedupeKeys.agentInstruction('delivery'),
      payload: {
        senderAgentId: 'main',
        recipientAgentId: 'child',
        instructionType: 'message',
        availability: 'captured',
        text: 'Check the empty state too.',
      },
    });
    for (const agentId of ['child', 'main']) {
      const steps = buildSteps([message, { ...message, id: ++id }], { sessionId: 's1', agentId });
      expect(steps).toHaveLength(1);
      expect(steps[0]?.detail).toBe('Check the empty state too.');
    }
  });
});

const { InstructionText } = await vi.importActual<{
  InstructionText: ComponentType<{
    text?: string;
    availability?: string;
    charCount?: number;
    truncated?: boolean;
  }>;
}>('../components/InstructionText.js');
const { ActivityStream } = await vi.importActual<{
  ActivityStream: ComponentType<{
    steps: Step[];
    selectedAgentId?: string;
    nameOf?: (id: string) => string | undefined;
  }>;
}>('../components/ActivityStream.js');
const render = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(I18nProvider, null, element));

describe('readable delegation text', () => {
  it('shows the Portuguese translation in the body and heading while keeping the recorded instruction unchanged', () => {
    const original = 'Please review the mobile navigation.';
    translations.target = 'pt';
    translations.values.set(original, 'Por favor revise a navegação em telas pequenas.');
    vi.stubGlobal('navigator', { language: 'pt-BR' });
    try {
      const source = assignment(original);
      const html = render(
        createElement(ActivityStream, {
          steps: buildSteps([source], filter),
          selectedAgentId: 'child',
        }),
      );
      expect(html).toContain('Por favor revise a navegação em telas pequenas.');
      expect(html).toContain('Tradução automática');
      expect(html).toContain('Ver original');
      expect(html).toContain('lang="pt"');
      expect(html).not.toContain(original);
      expect(source.payload).toMatchObject({ brief: original });
    } finally {
      translations.values.clear();
      translations.target = 'en';
      vi.unstubAllGlobals();
    }
  });
  it('keeps the full body beyond 700 characters, whitespace, and escapes markup', () => {
    const text = `Review\n  ${'An actual instruction. '.repeat(70)}\n<script>window.bad=true</script>\nFINAL REQUIREMENT`;
    const html = render(
      createElement(InstructionText, { text, charCount: text.length, truncated: false }),
    );
    expect(html).toContain('FINAL REQUIREMENT');
    expect(html).toContain('Review\n  An actual instruction.');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<details');
    expect(html).toContain('tabindex="0"');
  });

  it('distinguishes encrypted from absent records', () => {
    const encrypted = render(createElement(InstructionText, { availability: 'encrypted' }));
    const missing = render(createElement(InstructionText, { availability: 'missing' }));
    expect(encrypted).toContain('encrypted');
    expect(missing).toContain('readable instruction');
    expect(encrypted).not.toContain('Text not captured');
    expect(missing).not.toContain('Text not captured');
  });

  it('does not claim truncation solely because secret redaction shortened the text', () => {
    const html = render(
      createElement(InstructionText, {
        text: 'token [redacted]…',
        charCount: 200,
        truncated: false,
      }),
    );
    expect(html).not.toContain('first 16 of');
    const cut = render(
      createElement(InstructionText, { text: 'Beginning…', charCount: 100000, truncated: true }),
    );
    expect(cut).toContain('100000');
  });

  it('shows the instruction and the sender/recipient instead of the generic missing-prompt header', () => {
    const steps = buildSteps([assignment('Audit the application’s mobile navigation.')], filter);
    const html = render(
      createElement(ActivityStream, {
        steps,
        selectedAgentId: 'child',
        nameOf: (id: string) => (id === 'main' ? 'Principal' : 'Revisor'),
      }),
    );
    expect(html).toContain('Audit the application');
    expect(html).toContain('From Principal to Revisor');
    expect(html).not.toContain('Text not captured');
  });
});
