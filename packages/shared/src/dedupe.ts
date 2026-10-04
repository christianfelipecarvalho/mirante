import type { DraftEvent, MiranteEvent } from './event.js';
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
  /** A later assignment to the same agent. Its own fact, so it is not folded into the first. */
  agentFollowUp: (agentId: string, runId: string) => `agent.started:${agentId}:${runId}`,
  agentFollowUpFinished: (agentId: string, runId: string) => `agent.finished:${agentId}:${runId}`,
  agentFinished: (agentId: string) => `agent.finished:${agentId}`,
  sessionStarted: (sessionId: string) => `session.started:${sessionId}`,
  sessionEnded: (sessionId: string) => `session.ended:${sessionId}`,
  promptSubmitted: (promptId: string) => `prompt.submitted:${promptId}`,
  permissionRequested: (requestId: string) => `permission.requested:${requestId}`,
  permissionResolved: (requestId: string) => `permission.resolved:${requestId}`,
  /** Usage is reported per assistant message; the transcript entry uuid identifies it. */
  usageForMessage: (messageUuid: string) => `usage.updated:${messageUuid}`,
  /** One assistant message can hold several passages of prose; the index keeps them apart. */
  saidInMessage: (messageUuid: string, index: number) => `agent.said:${messageUuid}:${index}`,
  errorForMessage: (messageUuid: string) => `error.raised:${messageUuid}`,
  /** One cached figure, however many times it is read: Claude Code stamps each write. */
  planUsageCache: (fetchedAtMs: number) => `plan.usage.cache:${fetchedAtMs}`,
  turnFailed: (sessionId: string, agentId: string, promptId: string) =>
    `turn.failed:${sessionId}:${agentId}:${promptId}`,
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
  // Codex's equivalent of the transcript, and the only source for a Codex
  // session, so it never competes with another for the same fact.
  'codex-rollout': 40,
  sdk: 30,
  otel: 20,
  // The `/usage` command is pulled on demand and timestamped at the moment it
  // ran, so it supersedes a status line reading that was pushed earlier.
  'usage-command': 25,
  'usage-cache': 25,
  statusline: 15,
  hook: 10,
};

export const sourceOutranks = (incoming: EventSource, existing: EventSource): boolean =>
  SOURCE_PRECEDENCE[incoming] > SOURCE_PRECEDENCE[existing];

export const shouldSupersede = (incoming: DraftEvent, existing: DraftEvent): boolean =>
  sourceOutranks(incoming.source, existing.source);

/**
 * The key an event is collapsed by.
 *
 * A failed turn is reported twice — by the StopFailure hook and by the
 * transcript's refusal entry — and the two share nothing but the session, the
 * agent and the turn. Deriving the key from those, rather than trusting what was
 * stored, also collapses pairs written before this rule existed: the log is
 * append-only, so the fix has to hold on read.
 */
export const dedupeKeyOf = (event: DraftEvent | MiranteEvent): string | undefined => {
  // One conversation can be closed and resumed many times. Legacy hooks used
  // one key for its entire lifetime, which discarded every close after the
  // first and folded resume hooks into the original transcript start.
  if (event.kind === 'session.ended')
    return `${dedupeKeys.sessionEnded(event.sessionId)}:${event.ts}`;
  if (event.kind === 'session.started' && event.payload.resumed)
    return `${dedupeKeys.sessionStarted(event.sessionId)}:resume:${event.ts}`;
  return event.kind === 'error.raised' && event.promptId
    ? dedupeKeys.turnFailed(event.sessionId, event.agentId, event.promptId)
    : event.dedupeKey;
};

/**
 * Facts whose second report is a correction rather than a copy.
 *
 * The transcript is re-read whole whenever it changes, so a parser that learns
 * to read a new field starts reporting it for calls already recorded. For most
 * kinds a second report would double a count; for these it only refines what is
 * already on the card, so both the watcher and the projector let it through.
 * The projector's own counting guard is what keeps a re-read from inflating a
 * parent's running children.
 */
export const REREADABLE_KINDS: ReadonlySet<MiranteEvent['kind']> = new Set(['agent.started']);
