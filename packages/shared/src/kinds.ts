import { z } from 'zod';

/**
 * The normalized event vocabulary for M1.
 *
 * Adding a kind is a contract change: the observer and the future SDK driver must
 * both be able to emit it, or the UI would learn to tell them apart. See ADR-0002
 * and ADR-0001.
 */
export const EVENT_KINDS = [
  'session.started',
  'session.ended',
  'prompt.submitted',
  'agent.started',
  'agent.finished',
  'tool.started',
  'tool.finished',
  'tool.failed',
  'skill.invoked',
  'permission.requested',
  'permission.resolved',
  'usage.updated',
  'plan.usage.updated',
  'context.compacted',
  'waiting.changed',
  'error.raised',
] as const;

export const eventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof eventKindSchema>;

/**
 * Where an event came from.
 *
 * Recorded for auditing and deduplication only. `apps/web` must never branch on
 * it — that prohibition is what allows driver mode to be added later without
 * forking the UI. See ADR-0001.
 */
export const eventSourceSchema = z.enum(['hook', 'transcript', 'statusline', 'otel', 'sdk']);
export type EventSource = z.infer<typeof eventSourceSchema>;

/** How the session was launched. Separates terminal lanes from VS Code lanes on the board. */
export const entrypointSchema = z.enum(['cli', 'vscode', 'sdk', 'print', 'unknown']);
export type Entrypoint = z.infer<typeof entrypointSchema>;
