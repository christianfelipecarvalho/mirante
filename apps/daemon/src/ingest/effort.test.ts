import { describe, expect, it } from 'vitest';
import { reportedEffort } from '@mirante/shared';
import { hookPayloadSchema, hookToEvents } from './hooks.js';
import { statusLinePayloadSchema, statusLineToEvents } from './statusline.js';

describe('reasoning effort received live from Claude', () => {
  it('routes the setting inside a child hook to that child', () => {
    const events = hookToEvents(
      hookPayloadSchema.parse({
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        agent_id: 'child',
        tool_name: 'Read',
        tool_use_id: 'read-1',
        effort: { level: 'max' },
      }),
    );
    expect(events.find((event) => event.kind === 'agent.metadata.updated')).toMatchObject({
      agentId: 'child',
      payload: { effort: 'max' },
    });
  });

  it('accepts a status line setting even without cost or context readings', () => {
    const events = statusLineToEvents(
      statusLinePayloadSchema.parse({
        session_id: 'session',
        effort: { level: 'high' },
        model: { id: 'claude-opus-5-5' },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'agent.metadata.updated',
      payload: { effort: 'high' },
    });
  });

  it.each([undefined, null, {}, 'inherit', '[redacted effort: 5 chars]', { level: 100 }])(
    'leaves unavailable and malformed effort unknown: %j',
    (raw) => {
      expect(reportedEffort(raw)).toBeUndefined();
      expect(
        statusLineToEvents(statusLinePayloadSchema.parse({ session_id: 'session', effort: raw })),
      ).toEqual([]);
    },
  );
});
