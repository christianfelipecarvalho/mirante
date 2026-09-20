import type { DraftEvent } from './event.js';
import type { EventSource } from './kinds.js';

/**
 * Builders for `dedupeKey`.
 *
 * A hook and the transcript describe the same tool call from different angles and
 * at different times. Both are stored; the projector collapses them by this key.
 * The key must therefore depend only on identifiers both sources agree on —
 * never on a timestamp, a preview string, or which source observed it.
 */
export const dedupeKeys = {
  toolStarted: (toolUseId: string) => `tool.started:${toolUseId}`,
  toolFinished: (toolUseId: string) => `tool.finished:${toolUseId}`,
  toolFailed: (toolUseId: string) => `tool.failed:${toolUseId}`,
  agentStarted: (agentId: string) => `agent.started:${agentId}`,
  agentFinished: (agentId: string) => `agent.finished:${agentId}`,
  sessionStarted: (sessionId: string) => `session.started:${sessionId}`,
  sessionEnded: (sessionId: string) => `session.ended:${sessionId}`,
  promptSubmitted: (promptId: string) => `prompt.submitted:${promptId}`,
  permissionRequested: (requestId: string) => `permission.requested:${requestId}`,
  permissionResolved: (requestId: string) => `permission.resolved:${requestId}`,
  /** Usage is reported per assistant message; the transcript entry uuid identifies it. */
  usageForMessage: (messageUuid: string) => `usage.updated:${messageUuid}`,
} as const;

/**
 * Which source wins when two events share a `dedupeKey`.
 *
 * The transcript is the source of truth for content and token counts, so it
 * overwrites a hook's version of the same fact. Hooks still matter: they arrive
 * first, and the board should not sit empty waiting for a file flush.
 */
const SOURCE_PRECEDENCE: Record<EventSource, number> = {
  transcript: 40,
  sdk: 30,
  otel: 20,
  statusline: 15,
  hook: 10,
};

export const sourceOutranks = (incoming: EventSource, existing: EventSource): boolean =>
  SOURCE_PRECEDENCE[incoming] > SOURCE_PRECEDENCE[existing];

export const shouldSupersede = (incoming: DraftEvent, existing: DraftEvent): boolean =>
  sourceOutranks(incoming.source, existing.source);
