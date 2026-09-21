import { describe, expect, it } from 'vitest';
import { BoardProjector, MAIN_AGENT_ID, type DraftEvent, type MiranteEvent } from '@mirante/shared';
import { hookPayloadSchema, hookToEvents } from './hooks.js';
import { parseSessionTranscript } from './transcript/parse.js';

/**
 * The entry Claude Code wrote when a subagent hit the 5-hour limit on
 * 2026-09-20, redacted. Recorded from a real transcript; see EVENT_MAP §8.
 */
const SESSION = 'sess-limit';
const common = {
  sessionId: SESSION,
  cwd: '/home/user/project',
  version: '2.1.278',
  entrypoint: 'claude-vscode',
  promptId: 'p1',
};
const prompt = {
  ...common,
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-09-20T22:55:00.000Z',
  message: { role: 'user', content: 'review the header' },
};
const refusal = {
  ...common,
  type: 'assistant',
  uuid: 'a1',
  parentUuid: 'u1',
  timestamp: '2026-09-20T22:56:06.000Z',
  isApiErrorMessage: true,
  error: 'rate_limit',
  apiErrorStatus: 429,
  quotaLimits: {
    status: 'rejected',
    resetsAt: 1789952400,
    rateLimitType: 'five_hour',
    unifiedRateLimitFallbackAvailable: false,
  },
  message: {
    model: '<synthetic>',
    role: 'assistant',
    content: [
      { type: 'text', text: "You've hit your session limit · resets 10pm (America/Sao_Paulo)" },
    ],
    // Verbatim from the real entry. An earlier version of this fixture wrote the
    // usage from memory, without the nulls, and passed while the parser dropped
    // every real refusal as unreadable.
    usage: {
      output_tokens_details: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: null,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      inference_geo: null,
      iterations: null,
      speed: null,
    },
  },
};

const errorsOf = (events: DraftEvent[]) => events.filter((e) => e.kind === 'error.raised');

let nextId = 0;
const stored = (draft: DraftEvent): MiranteEvent =>
  ({ ...draft, id: (nextId += 1), receivedTs: draft.ts }) as MiranteEvent;

describe('a request refused at the plan limit', () => {
  it('is read from the transcript as a limit, with the window and when it reopens', () => {
    const [error] = errorsOf(parseSessionTranscript({ mainLines: [prompt, refusal] }).events);
    expect(error?.payload).toMatchObject({
      kind: 'rate_limit',
      limit: { window: 'fiveHour', resetsAt: 1789952400 },
    });
  });

  it('does not count the synthetic entry as model usage', () => {
    const events = parseSessionTranscript({ mainLines: [prompt, refusal] }).events;
    expect(events.some((e) => e.kind === 'usage.updated')).toBe(false);
  });

  /**
   * StopFailure carries `error` and `last_assistant_message`. Mirante read
   * `message`, which is not on this hook, so every failure — five on record —
   * arrived as "Turn ended with an error".
   */
  it('is read from the StopFailure hook by the fields that hook actually has', () => {
    const payload = hookPayloadSchema.parse({
      hook_event_name: 'StopFailure',
      session_id: SESSION,
      cwd: '/home/user/project',
      error: 'rate_limit',
      last_assistant_message: "You've hit your session limit · resets 10pm (America/Sao_Paulo)",
    });
    const [error] = errorsOf(hookToEvents(payload));
    expect(error?.payload).toMatchObject({
      kind: 'rate_limit',
      message: "You've hit your session limit · resets 10pm (America/Sao_Paulo)",
    });
  });

  it('keeps the window when the hook, which lacks it, lands after the transcript', () => {
    const projector = new BoardProjector();
    const fromTranscript = parseSessionTranscript({ mainLines: [prompt, refusal] }).events;
    const fromHook = hookToEvents(
      hookPayloadSchema.parse({
        hook_event_name: 'StopFailure',
        session_id: SESSION,
        cwd: '/home/user/project',
        error: 'rate_limit',
      }),
    );
    projector.applyAll([...fromTranscript, ...fromHook].map(stored));

    const main = projector
      .snapshot()
      .sessions[0]?.cards.find((card) => card.agentId === MAIN_AGENT_ID);
    expect(main?.status.state).toBe('error');
    expect(main?.stoppedAtLimit).toEqual({ window: 'fiveHour', resetsAt: 1789952400 });
  });

  it('forgets the limit when a later failure has another cause', () => {
    const projector = new BoardProjector();
    const later = hookToEvents(
      hookPayloadSchema.parse({
        hook_event_name: 'StopFailure',
        session_id: SESSION,
        cwd: '/home/user/project',
        error: 'server_error',
      }),
    );
    projector.applyAll(
      [...parseSessionTranscript({ mainLines: [prompt, refusal] }).events, ...later].map(stored),
    );
    const main = projector.snapshot().sessions[0]?.cards[0];
    expect(main?.stoppedAtLimit).toBeUndefined();
  });
});
