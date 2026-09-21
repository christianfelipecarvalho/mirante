import type { CardState, CardStatus } from '@mirante/shared';
import { useI18n } from '../lib/i18n';
import { Icon, type IconName } from './Icon';

type Meta = { icon: IconName; color: string };

/**
 * Status always ships as icon plus label.
 *
 * Colour alone would fail for a colourblind reader, in grayscale, and at the
 * glance distance this board is actually read from.
 */
export const STATE_META: Record<CardState, Meta> = {
  idle: { icon: 'circle', color: 'var(--text-muted)' },
  thinking: { icon: 'thinking', color: 'var(--accent)' },
  tool_running: { icon: 'play', color: 'var(--accent)' },
  waiting_approval: { icon: 'alert', color: 'var(--status-warning)' },
  waiting_input: { icon: 'alert', color: 'var(--status-warning)' },
  waiting_subagent: { icon: 'down', color: 'var(--accent)' },
  rate_limited: { icon: 'pause', color: 'var(--status-serious)' },
  done: { icon: 'check', color: 'var(--status-good)' },
  error: { icon: 'cross', color: 'var(--status-critical)' },
};

/**
 * States the interface derives rather than receives: a card stopped by a plan
 * limit, and a card that claims to be working but has gone silent.
 */
export type BadgeOverride = 'interrupted' | 'silent';

const OVERRIDE_META: Record<BadgeOverride, Meta> = {
  // Orange and a pause, not red and a cross: nothing broke. The plan said stop.
  interrupted: { icon: 'pause', color: 'var(--status-serious)' },
  // Muted and hollow: this is not a state, it is the absence of one.
  silent: { icon: 'circle', color: 'var(--text-muted)' },
};

export const StateBadge = ({
  status,
  override,
  title,
}: {
  status: CardStatus;
  override?: BadgeOverride | undefined;
  title?: string | undefined;
}) => {
  const { t } = useI18n();
  const meta = override ? OVERRIDE_META[override] : STATE_META[status.state];
  const label = override
    ? t(`state.${override}` as 'state.idle')
    : t(`state.${status.state}` as 'state.idle');

  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        color: meta.color,
        background: 'color-mix(in oklab, currentColor 12%, transparent)',
      }}
    >
      {/* Still, on purpose. With eight agents working, eight pulsing badges are
          noise in peripheral vision, and they drown out the one thing that is
          allowed to move: a project waiting on you. */}
      <Icon name={meta.icon} size={12} />
      {label}
    </span>
  );
};
