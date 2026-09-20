import { formatReset } from '../lib/format';

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
  percentage: number | undefined;
  resetsAt?: number | undefined;
};

export const Meter = ({ label, percentage, resetsAt }: MeterProps) => {
  // Absence is not zero. Plan usage is missing for API-key users, before the
  // first API response, and once a window has reset — saying "unknown" is the
  // only honest rendering.
  const known = percentage !== undefined;
  const value = Math.min(100, Math.max(0, percentage ?? 0));

  return (
    <div className="min-w-[132px] flex-1">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-[var(--text-secondary)]">{label}</span>
        <span className="tabular text-[11px] font-medium text-[var(--text-primary)]">
          {known ? `${value.toFixed(0)}%` : 'unknown'}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: 'var(--accent-track)' }}
        role="meter"
        aria-valuenow={known ? value : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        {known && (
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${Math.max(value, 1.5)}%`, background: fillFor(value) }}
          />
        )}
      </div>
      {known && resetsAt !== undefined && (
        <div className="mt-1 text-[10px] text-[var(--text-muted)]">{formatReset(resetsAt)}</div>
      )}
    </div>
  );
};
