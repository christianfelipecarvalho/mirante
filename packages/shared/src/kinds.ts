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
  'agent.said',
  'agent.metadata.updated',
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
export const eventSourceSchema = z.enum([
  'hook',
  'transcript',
  'statusline',
  'usage-command',
  // Claude Code's cached plan figure, read from its state file. Its own source so
  // the log does not claim a command ran every minute when a file was read.
  'usage-cache',
  'otel',
  'sdk',
  // An OpenAI Codex rollout file. Codex writes one per thread, and it is the
  // only thing Mirante reads of Codex. See ADR-0008.
  'codex-rollout',
]);
export type EventSource = z.infer<typeof eventSourceSchema>;

/**
 * Which coding agent runs the session: a property of the session, like where
 * it was launched from.
 *
 * Not to be confused with `source`, which is how Mirante learned of an event.
 * An observed Codex session and a driven one would share a harness and differ
 * in source, and the interface may name the first but never branch on the
 * second. See ADR-0008 and ADR-0001.
 */
export const harnessSchema = z.enum(['claude-code', 'codex']);
export type Harness = z.infer<typeof harnessSchema>;

/** How the session was launched. Separates terminal lanes from VS Code lanes on the board. */
export const entrypointSchema = z.enum(['cli', 'vscode', 'sdk', 'print', 'unknown']);
export type Entrypoint = z.infer<typeof entrypointSchema>;
