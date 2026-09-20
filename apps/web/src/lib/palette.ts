/**
 * Categorical slots for agent identity, in fixed order.
 *
 * Assigned by order of appearance within a lane rather than hashed, because the
 * order is the safety mechanism: these eight were validated as a sequence, and
 * picking slots at random puts adjacent hues together that were never checked
 * as a pair. Past eight, agents fall back to neutral rather than inventing a
 * hue.
 *
 * The values live in CSS as custom properties, with their own steps per theme —
 * a colour picked in JavaScript would carry one theme's step into the other.
 */
export const AGENT_SLOT_COUNT = 8;

export const NEUTRAL_SLOT = 'var(--agent-neutral)';

export const agentColor = (index: number): string =>
  index < 0 || index >= AGENT_SLOT_COUNT ? NEUTRAL_SLOT : `var(--agent-${index + 1})`;
