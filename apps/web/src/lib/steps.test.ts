import { describe, expect, it } from 'vitest';
import type { MiranteEvent } from '@mirante/shared';
import { buildSteps, groupStepsByTurn } from './steps.js';

const finish = (
  id: number,
  payload: Record<string, unknown>,
  source: MiranteEvent['source'] = 'transcript',
): MiranteEvent =>
  ({
    id,
    ts: '2026-10-11T12:00:00.000Z',
    receivedTs: '2026-10-11T12:00:01.000Z',
    source,
    sessionId: 'response-test',
    projectPath: '/tmp/synthetic',
    agentId: 'child',
    agentType: 'reviewer',
    promptId: 'turn-1',
    kind: 'agent.finished',
    dedupeKey: 'agent.finished:child',
    payload: { outcome: 'ok', ...payload },
  }) as MiranteEvent;
const filter = { sessionId: 'response-test', agentId: 'child' };
describe('agent return evidence in activity', () => {
  it('retains response paragraphs, elapsed time and interrupted outcome', () => {
    const [step] = buildSteps(
      [
        finish(1, {
          outcome: 'interrupted',
          resultPreview: 'First finding.\n\nStill pending.',
          durationMs: 1234,
          resultTruncated: false,
          resultAvailability: 'captured',
        }),
      ],
      filter,
    );
    expect(step).toMatchObject({
      verb: 'returned',
      detail: 'First finding.\n\nStill pending.',
      durationMs: 1234,
      returnOutcome: 'interrupted',
      status: 'limited',
      result: { availability: 'captured', truncated: false },
    });
    expect(groupStepsByTurn([step!], 'child')[0]?.steps).toContain(step);
  });
  it('accepts a richer finish reread and preserves captured text when a later report omits it', () => {
    const steps = buildSteps(
      [
        finish(1, {}),
        finish(2, {
          resultPreview: 'Recovered response.',
          resultTruncated: false,
          resultAvailability: 'captured',
          resultCharCount: 19,
        }),
        finish(3, {}),
      ],
      filter,
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      id: 3,
      detail: 'Recovered response.',
      result: { truncated: false, charCount: 19 },
    });
  });
  it('preserves explicit truncation and encrypted availability without manufacturing content', () => {
    const [partial] = buildSteps(
      [
        finish(1, {
          resultPreview: 'Captured excerpt.',
          resultTruncated: true,
          resultCharCount: 600,
        }),
      ],
      filter,
    );
    expect(partial).toMatchObject({
      detail: 'Captured excerpt.',
      result: { truncated: true, charCount: 600 },
    });
    const [encrypted] = buildSteps([finish(2, { resultAvailability: 'encrypted' })], filter);
    expect(encrypted?.result?.availability).toBe('encrypted');
    expect(encrypted?.detail).toBeUndefined();
  });
  it('keeps failed returns failed without borrowing text from a neighboring agent message', () => {
    const [step] = buildSteps([finish(1, { outcome: 'error' })], filter);
    expect(step).toMatchObject({ status: 'failed', returnOutcome: 'error' });
    expect(step?.detail).toBeUndefined();
  });
});

it('keeps the explicit return under an injected hand-back group without revealing its envelope', () => {
  const returned = finish(2, { resultPreview: 'Observed return text.', resultTruncated: false });
  const injected = {
    ...finish(1, {}),
    agentId: 'main',
    kind: 'prompt.submitted',
    dedupeKey: 'prompt:notification',
    payload: {
      preview: '<task-notification>unrendered notification envelope</task-notification>',
      charCount: 76,
    },
  } as MiranteEvent;
  const steps = buildSteps([injected, returned], { sessionId: 'response-test' });
  const [group] = groupStepsByTurn(steps);
  expect(group?.origin).toBe('agent');
  expect(group?.steps).toHaveLength(1);
  expect(group?.steps[0]?.detail).toBe('Observed return text.');
  expect(
    group?.steps.some((step) => step.detail?.includes('unrendered notification envelope')),
  ).toBe(false);
});
