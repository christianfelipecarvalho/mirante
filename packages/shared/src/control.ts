import { z } from 'zod';
import type { AgentCard } from './board.js';
import { livenessOf } from './liveness.js';

export const agentControlPayload = z.object({
  runId: z.string().min(1),
  operation: z.enum(['verify', 'resume']),
  status: z.enum(['queued', 'running', 'stopping', 'completed', 'failed', 'interrupted', 'lost']),
  requestedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  verdict: z.enum(['completed', 'pending', 'blocked', 'unknown']).optional(),
  summary: z.string().optional(),
  reason: z.string().optional(),
});

/** A command's acknowledged execution, separate from an observed agent's state. */
export type AgentControlRun = z.infer<typeof agentControlPayload> & {
  sessionId: string;
  agentId: string;
};

/** An ended process is not evidence that its assignment was completed. */
export const completionOf = (card: AgentCard) => {
  if (card.stoppedAtLimit || card.outcome === 'interrupted') return 'interrupted' as const;
  if (card.outcome === 'error' || card.status.state === 'error') return 'failed' as const;
  if (card.outcome === 'ok') return 'completed' as const;
  if (card.endedAt || card.status.state === 'done') return 'unknown' as const;
  return undefined;
};

export const needsRecovery = (card: AgentCard, now: number, sessionEnded = false): boolean => {
  const completion = completionOf(card);
  return (
    (completion !== undefined && completion !== 'completed') ||
    livenessOf(card, now, sessionEnded) === 'silent'
  );
};

export type AgentControlFailure =
  | 'unknown-session'
  | 'unknown-agent'
  | 'already-running'
  | 'session-busy'
  | 'completed-agent'
  | 'unsupported-session'
  | 'missing-project'
  | 'cli-not-found'
  | 'launch-failed'
  | 'invalid-result'
  | 'permission-required'
  | 'command-failed'
  | 'timeout'
  | 'not-owned'
  | 'no-eligible-agents'
  | 'unreachable';

export type AgentControlResult =
  | { ok: true; runIds: string[]; skipped: { agentId: string; reason: AgentControlFailure }[] }
  | { ok: false; reason: AgentControlFailure };
