import type { AgentCard } from './board.js';

/**
 * Shared by the board and the daemon: the loading bar and the automatic plan
 * reading (ADR-0007) must agree on what "working" means.
 *
 * How long a card may claim to be working without a single event before the
 * claim stops being believed.
 *
 * Generous on purpose: a long build or test run emits nothing while it runs.
 * The case this catches is the other one — an agent whose finish never reached
 * Mirante, still "running" twelve hours later.
 */
export const SILENT_AFTER_MS = 30 * 60_000;

/**
 * - `live`: working, and has said so recently. Earns the loading bar.
 * - `silent`: says it is working, has not been heard from in a long while.
 *   Shown as "no signal", never as running — absent data reads as unknown.
 * - `rest`: every other state.
 */
export type Liveness = 'live' | 'silent' | 'rest';

export const livenessOf = (card: AgentCard, now: number, sessionEnded = false): Liveness => {
  const working = card.status.state === 'thinking' || card.status.state === 'tool_running';
  if (!working) return 'rest';
  if (sessionEnded) return 'silent';
  const last = Date.parse(card.lastEventAt ?? card.startedAt);
  return Number.isFinite(last) && now - last <= SILENT_AFTER_MS ? 'live' : 'silent';
};
