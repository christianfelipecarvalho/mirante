import { useState } from 'react';
import { PLAN_READING_MAX_AGE_MS, type BoardState } from '@mirante/shared';
import type { PlanUsageRefresh } from '../lib/client';
import { useI18n } from '../lib/i18n';
import { readWindow } from '../lib/plan';
import { Icon } from './Icon';
import { Meter } from './Meter';

type Failure = Extract<PlanUsageRefresh, { ok: false }>['reason'];

/**
 * Plan limits as one unit: the control that reads them now, how old the figure
 * is, and the two windows.
 *
 * The figure refreshes by itself every minute while an agent is working (see
 * ADR-0007), so the button says "now": it is for when you want a fresh number
 * this instant. Automatic reads show nothing but the meters moving. The age
 * line says how old the figure is — with nothing running it is not read, so
 * that is also how long since agents last worked. A failure takes the age's
 * place instead of adding a row, so the header never changes height.
 */
export const PlanMeters = ({
  board,
  now,
  onRefresh,
}: {
  board: BoardState;
  now: number;
  onRefresh: () => Promise<PlanUsageRefresh>;
}) => {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();

  const read = async () => {
    setBusy(true);
    setFailure(undefined);
    const result = await onRefresh();
    if (!result.ok) setFailure(result.reason);
    setBusy(false);
  };

  const readAt = board.planUsageUpdatedAt ? Date.parse(board.planUsageUpdatedAt) : undefined;
  const known = readAt !== undefined && Number.isFinite(readAt);
  const minutes = known ? Math.max(0, Math.round((now - readAt) / 60_000)) : 0;
  // Past an hour the figure is older than Claude Code itself trusts; the icon
  // changes shape as well as the colour, so the warning survives greyscale.
  const old = known && now - readAt > PLAN_READING_MAX_AGE_MS;
  const age = !known
    ? t('plan.noReading')
    : minutes < 1
      ? t('plan.ago.justNow')
      : minutes <= 5
        ? t('plan.ago.minutes', { n: minutes })
        : t('plan.lastUsed', {
            d: minutes < 60 ? `${minutes}min` : `${Math.round(minutes / 60)}h`,
          });

  const title = known
    ? t('plan.refreshTitleAt', { time: new Date(readAt).toLocaleString() })
    : t('plan.refreshTitle');

  return (
    <section aria-label={t('plan.limits')} className="flex items-start gap-5">
      <div className="flex w-[118px] shrink-0 flex-col items-start gap-1">
        <button
          type="button"
          onClick={read}
          disabled={busy}
          aria-busy={busy}
          title={title}
          className="pressable flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors duration-200 hover:border-[var(--accent)] disabled:cursor-wait"
          style={{
            borderColor: 'var(--hairline)',
            color: busy ? 'var(--text-muted)' : 'var(--text-primary)',
          }}
        >
          <Icon name="refresh" size={13} className={busy ? 'animate-spin' : undefined} />
          {busy ? t('plan.refreshing') : t('plan.refresh')}
        </button>

        {/* Colour never carries the failure alone: icon and sentence say it. */}
        {failure && !busy ? (
          <span
            role="status"
            className="flex items-start gap-1 text-[10px] leading-tight"
            style={{ color: 'var(--status-serious)' }}
          >
            <Icon name="alert" size={11} className="mt-px shrink-0" />
            {t(`plan.error.${failure}` as 'plan.error.command-failed')}
          </span>
        ) : (
          <span
            className="flex items-center gap-1 text-[10px] whitespace-nowrap"
            style={{ color: old ? 'var(--text-secondary)' : 'var(--text-muted)' }}
          >
            {old && <Icon name="clock" size={11} />}
            {age}
          </span>
        )}
      </div>

      <Meter
        label={t('plan.fiveHour.short')}
        reading={readWindow(board.planUsage?.fiveHour, now)}
      />
      <Meter label={t('plan.weekly.short')} reading={readWindow(board.planUsage?.sevenDay, now)} />
      {board.planUsage?.spendLimit && (
        <Meter label={t('plan.spend')} reading={readWindow(board.planUsage.spendLimit, now)} />
      )}
    </section>
  );
};
