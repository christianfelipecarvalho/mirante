/**
 * Categorical slots for agent identity, in fixed order.
 *
 * Assigned by order of appearance within a lane rather than hashed, because the
 * order is the safety mechanism: these eight were validated as a sequence, and
 * picking slots at random puts adjacent hues together that were never checked as
 * a pair. Past eight, agents fall back to neutral rather than inventing a hue.
 *
 * These are the dark-surface steps. They are deliberately distinct from the
 * status palette, so an agent's colour never impersonates a state.
 */
export const AGENT_SLOTS = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const;

export const NEUTRAL_SLOT = '#898781';

export const agentColor = (index: number): string =>
  index < 0 || index >= AGENT_SLOTS.length ? NEUTRAL_SLOT : (AGENT_SLOTS[index] as string);
