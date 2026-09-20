import type { CardState, CardStatus } from '@mirante/shared';

type Meta = { label: string; icon: string; color: string };

/**
 * Status always ships as icon plus label.
 *
 * Colour alone would fail for a colourblind reader, in grayscale, and at the
 * glance distance this board is actually read from.
 */
export const STATE_META: Record<CardState, Meta> = {
  idle: { label: 'Idle', icon: '○', color: 'var(--text-muted)' },
  thinking: { label: 'Thinking', icon: '◐', color: 'var(--accent)' },
  tool_running: { label: 'Running', icon: '▶', color: 'var(--accent)' },
  waiting_approval: { label: 'Needs approval', icon: '⚠', color: 'var(--status-warning)' },
  waiting_input: { label: 'Waiting for you', icon: '⚠', color: 'var(--status-warning)' },
  waiting_subagent: { label: 'Waiting on agent', icon: '⇣', color: 'var(--accent)' },
  rate_limited: { label: 'Rate limited', icon: '⏸', color: 'var(--status-serious)' },
  done: { label: 'Done', icon: '✓', color: 'var(--status-good)' },
  error: { label: 'Error', icon: '✕', color: 'var(--status-critical)' },
};

export const StateBadge = ({ status }: { status: CardStatus }) => {
  const meta = STATE_META[status.state];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        color: meta.color,
        background: 'color-mix(in oklab, currentColor 12%, transparent)',
      }}
    >
      <span aria-hidden="true">{meta.icon}</span>
      {meta.label}
    </span>
  );
};
