import { z } from 'zod';
import { agentIdSchema } from './agent.js';
import { eventSourceSchema } from './kinds.js';
import * as p from './payloads.js';

/**
 * Fields every normalized event carries, whatever produced it.
 */
export const eventEnvelopeSchema = z.object({
  /**
   * Gapless, monotonically increasing, assigned by the daemon on append. Clients
   * replay from any id, which is what makes reopening the browser rebuild the
   * board rather than start it empty.
   */
  id: z.number().int().positive(),

  /**
   * When the thing happened, as the source reported it. ISO 8601.
   *
   * Kept separate from `receivedTs` because hooks arrive before the transcript is
   * flushed. Ordering the timeline by arrival would scramble it; ordering the
   * live view by origin time alone would stall it. Both are needed.
   */
  ts: z.string().datetime(),

  /** When the daemon accepted it. ISO 8601. */
  receivedTs: z.string().datetime(),

  source: eventSourceSchema,

  sessionId: z.string().min(1),
  projectPath: z.string(),
  gitBranch: z.string().optional(),

  /** Never absent: the session's root card uses the `main` sentinel. */
  agentId: agentIdSchema,
  agentType: z.string().optional(),
  parentAgentId: agentIdSchema.optional(),

  /** `prompt_id` or `tool_use_id`, for stitching a turn together across sources. */
  correlationId: z.string().optional(),

  /**
   * Identity of the underlying fact, when two sources can report it.
   *
   * The log keeps every record because it is an audit trail; the projector folds
   * by this key. Without it a tool call reported by both a hook and the
   * transcript would render twice. See ADR-0002.
   */
  dedupeKey: z.string().optional(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

const defineEvent = <K extends string, P extends z.ZodTypeAny>(kind: K, payload: P) =>
  eventEnvelopeSchema.extend({ kind: z.literal(kind), payload });

export const miranteEventSchema = z.discriminatedUnion('kind', [
  defineEvent('session.started', p.sessionStartedPayload),
  defineEvent('session.ended', p.sessionEndedPayload),
  defineEvent('prompt.submitted', p.promptSubmittedPayload),
  defineEvent('agent.started', p.agentStartedPayload),
  defineEvent('agent.finished', p.agentFinishedPayload),
  defineEvent('tool.started', p.toolStartedPayload),
  defineEvent('tool.finished', p.toolFinishedPayload),
  defineEvent('tool.failed', p.toolFailedPayload),
  defineEvent('skill.invoked', p.skillInvokedPayload),
  defineEvent('permission.requested', p.permissionRequestedPayload),
  defineEvent('permission.resolved', p.permissionResolvedPayload),
  defineEvent('usage.updated', p.usageUpdatedPayload),
  defineEvent('plan.usage.updated', p.planUsageUpdatedPayload),
  defineEvent('context.compacted', p.contextCompactedPayload),
  defineEvent('waiting.changed', p.waitingChangedPayload),
  defineEvent('error.raised', p.errorRaisedPayload),
]);

export type MiranteEvent = z.infer<typeof miranteEventSchema>;

/** Narrow to one kind: `MiranteEventOf<'tool.started'>`. */
export type MiranteEventOf<K extends MiranteEvent['kind']> = Extract<MiranteEvent, { kind: K }>;

export type PayloadOf<K extends MiranteEvent['kind']> = MiranteEventOf<K>['payload'];

/**
 * An event as a producer builds it, before the daemon assigns identity.
 *
 * Normalizers return this shape; only the event log may set `id` and
 * `receivedTs`. Keeping them out of the producer's reach is what guarantees the
 * log stays gapless and monotonic.
 */
export type DraftEvent = {
  [K in MiranteEvent['kind']]: Omit<MiranteEventOf<K>, 'id' | 'receivedTs'>;
}[MiranteEvent['kind']];

export const isEventOfKind = <K extends MiranteEvent['kind']>(
  event: MiranteEvent,
  kind: K,
): event is MiranteEventOf<K> => event.kind === kind;

/** Validate at a trust boundary — file parsing, hook ingest, WebSocket input. */
export const parseMiranteEvent = (input: unknown): MiranteEvent => miranteEventSchema.parse(input);

export const safeParseMiranteEvent = (input: unknown) => miranteEventSchema.safeParse(input);
