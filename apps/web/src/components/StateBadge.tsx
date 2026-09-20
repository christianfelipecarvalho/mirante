import type { CardState, CardStatus } from '@mirante/shared';
import { useI18n } from '../lib/i18n';

type Meta = { icon: string; color: string };

/**
 * Status always ships as icon plus label.
 *
 * Colour alone would fail for a colourblind reader, in grayscale, and at the
 * glance distance this board is actually read from.
 */
export const STATE_META: Record<CardState, Meta> = {
  idle: { icon: '○', color: 'var(--text-muted)' },
  thinking: { icon: '◐', color: 'var(--accent)' },
  tool_running: { icon: '▶', color: 'var(--accent)' },
  waiting_approval: { icon: '⚠', color: 'var(--status-warning)' },
  waiting_input: { icon: '⚠', color: 'var(--status-warning)' },
  waiting_subagent: { icon: '⇣', color: 'var(--accent)' },
  rate_limited: { icon: '⏸', color: 'var(--status-serious)' },
  done: { icon: '✓', color: 'var(--status-good)' },
  error: { icon: '✕', color: 'var(--status-critical)' },
};

export const StateBadge = ({ status }: { status: CardStatus }) => {
  const { t } = useI18n();
  const meta = STATE_META[status.state];
  const live = status.state === 'tool_running' || status.state === 'thinking';

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        color: meta.color,
        background: 'color-mix(in oklab, currentColor 12%, transparent)',
      }}
    >
      <span aria-hidden="true" className={live ? 'animate-pulse' : undefined}>
        {meta.icon}
      </span>
      {t(`state.${status.state}` as 'state.idle')}
    </span>
  );
};
