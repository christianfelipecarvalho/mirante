import { formatReset } from '../lib/format';
import { useI18n } from '../lib/i18n';
import type { WindowReading } from '../lib/plan';
import { Icon } from './Icon';

/**
 * Severity rides the fill; the track is a dimmer step of the same ramp, so the
 * bar reads as one object rather than as a coloured sliver on grey.
 */
const fillFor = (percentage: number): string => {
  if (percentage >= 100) return 'var(--status-critical)';
  if (percentage >= 85) return 'var(--status-serious)';
  if (percentage >= 60) return 'var(--status-warning)';
  return 'var(--accent)';
};

export type MeterProps = {
  label: string;
  reading: WindowReading;
};

/**
 * One plan window.
 *
 * Three answers, drawn three ways. A reading gets a filled bar. No reading, and
 * a reading whose window has since reset, both get a hatched track — an empty
 * solid track looks like 0%, and 0% is a claim this meter cannot make.
 */
export const Meter = ({ label, reading }: MeterProps) => {
  const { t } = useI18n();
  const known = reading.state === 'known';
  const value = known ? Math.min(100, Math.max(0, reading.percentage)) : 0;
  const atLimit = known && value >= 100;
  const near = known && value >= 85;

  const figure = !known ? t('plan.unknown') : atLimit ? t('plan.atLimit') : `${value.toFixed(0)}%`;

  const footnote =
    reading.state === 'known'
      ? formatReset(reading.resetsAt, t)
      : reading.state === 'reset'
        ? t('plan.windowReset')
        : '';

  return (
    <div className="w-[176px] min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-[var(--text-secondary)]">{label}</span>
        <span
          className="tabular flex items-center gap-1 text-[12px] font-medium"
          style={{ color: near ? fillFor(value) : 'var(--text-primary)' }}
        >
          {/* Near the ceiling the colour changes, and so does the shape: an icon,
              then at 100% a word, so the warning survives greyscale. */}
          {near && <Icon name="alert" size={11} />}
          {figure}
        </span>
      </div>
      <div
        className={`h-1.5 w-full overflow-hidden rounded-full ${known ? '' : 'hatch'}`}
        style={known ? { background: 'var(--accent-track)' } : undefined}
        role="meter"
        aria-valuenow={known ? value : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={known ? `${value.toFixed(0)}%` : t('plan.unknown')}
        aria-label={label}
      >
        {known && (
          <div
            className="h-full rounded-full transition-[width] duration-[250ms]"
            style={{ width: `${Math.max(value, 1.5)}%`, background: fillFor(value) }}
          />
        )}
      </div>
      <div className="mt-1 h-[14px] truncate text-[10px] text-[var(--text-muted)]">{footnote}</div>
    </div>
  );
};
