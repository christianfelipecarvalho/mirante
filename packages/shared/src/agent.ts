import { z } from 'zod';

/**
 * Every event belongs to exactly one card. The root card of a session — the one
 * the human is typing into — uses this sentinel rather than an absent id, so no
 * consumer has to branch on whether an agent id exists.
 */
export const MAIN_AGENT_ID = 'main' as const;

export const agentIdSchema = z.string().min(1);
export type AgentId = z.infer<typeof agentIdSchema>;

export const isMainAgent = (agentId: AgentId): boolean => agentId === MAIN_AGENT_ID;

/**
 * How a subagent was launched. A synchronous call blocks the parent, which is
 * what puts the parent card into `waiting_subagent`. An asynchronous one does
 * not: Claude Code reports `status: "async_launched"` and the parent keeps
 * working while the subagent runs alongside it.
 *
 * Conflating the two is the single easiest way to render a parent as blocked
 * when it is in fact busy. See docs/EVENT_MAP.md §6 D3.
 */
export const spawnModeSchema = z.enum(['sync', 'async']);
export type SpawnMode = z.infer<typeof spawnModeSchema>;
