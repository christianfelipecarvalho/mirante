import { z } from 'zod';

/** States in which the card is doing something, or has stopped doing anything. */
export const ACTIVE_CARD_STATES = ['idle', 'thinking', 'tool_running', 'done', 'error'] as const;

/**
 * States in which the card is blocked on something outside itself.
 *
 * `rate_limited` counts as waiting: the thing being waited on is the limit window
 * resetting.
 */
export const WAITING_CARD_STATES = [
  'waiting_approval',
  'waiting_input',
  'waiting_subagent',
  'rate_limited',
] as const;

export const CARD_STATES = [...ACTIVE_CARD_STATES, ...WAITING_CARD_STATES] as const;

export const cardStateSchema = z.enum(CARD_STATES);
export type CardState = z.infer<typeof cardStateSchema>;

export type WaitingCardState = (typeof WAITING_CARD_STATES)[number];

export const isWaitingState = (state: CardState): state is WaitingCardState =>
  (WAITING_CARD_STATES as readonly string[]).includes(state);

/**
 * What a blocked card is waiting on.
 *
 * This is the product. A card that reports only that it is waiting, without
 * naming what for, is a bug — so `summary` is required and the type system
 * refuses to let a waiting state exist without one.
 */
export const waitingOnSchema = z.object({
  /** Short enough for one line on a card. "Approve: rm -rf build/", "Explore agent running". */
  summary: z.string().min(1),
  /** Optional longer text for the expanded card or a tooltip. */
  detail: z.string().optional(),
  /** ISO 8601. Drives the "stalled for N minutes" indicator. */
  since: z.string().datetime(),
  /** Correlates back to the thing being awaited: a permission request, a subagent, a tool use. */
  ref: z.string().optional(),
  /**
   * Why the card is blocked, as a value rather than as prose.
   *
   * `summary` stays the source of truth and the fallback, but a UI that has to
   * render in more than one language cannot translate a sentence the daemon
   * already wrote. These two let it build its own.
   */
  reason: z.enum(['subagent', 'approval', 'input', 'plan_limit']).optional(),
  /** What is being waited on: an agent type, a tool name, a limit window. */
  subject: z.string().optional(),
});
export type WaitingOn = z.infer<typeof waitingOnSchema>;

/**
 * A card's state, with the waiting reason attached at the type level.
 *
 * Modelled as a union rather than `{ state, waitingOn? }` so that constructing a
 * waiting state without a reason does not compile. This encodes the rule in
 * CLAUDE.md instead of relying on review to catch it.
 */
export const cardStatusSchema = z.union([
  z.object({
    state: z.enum(ACTIVE_CARD_STATES),
    waitingOn: z.undefined().optional(),
  }),
  z.object({
    state: z.enum(WAITING_CARD_STATES),
    waitingOn: waitingOnSchema,
  }),
]);
export type CardStatus = z.infer<typeof cardStatusSchema>;

/**
 * Terminal states. A card that reached one is not expected to transition again
 * within its lifetime; the projector treats a later event for it as a late
 * arrival to record, not a reason to reopen the card.
 */
export const TERMINAL_CARD_STATES = ['done', 'error'] as const;

export const isTerminalState = (state: CardState): boolean =>
  (TERMINAL_CARD_STATES as readonly string[]).includes(state);
