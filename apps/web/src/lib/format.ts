import type { TokenUsage } from '@mirante/shared';
import { totalTokens } from '@mirante/shared';

/** Auto-compact, per the stat-tile contract: 1,284 / 12.9K / 4.2M. */
export const compactNumber = (value: number): string => {
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
};

export const formatTokens = (usage: TokenUsage): string => compactNumber(totalTokens(usage));

export const formatCost = (usd: number | undefined): string =>
  usd === undefined ? '—' : `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;

export const formatDuration = (fromIso: string, toIso?: string): string => {
  const from = Date.parse(fromIso);
  const to = toIso ? Date.parse(toIso) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '—';
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export const formatClock = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '--:--:--'
    : date.toLocaleTimeString(undefined, { hour12: false });
};

/**
 * Clock time, plus the date when it is not today.
 *
 * A list sorted correctly across days still reads as scrambled when every row
 * shows only a wall-clock time.
 */
export const formatWhen = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const clock = date.toLocaleTimeString(undefined, { hour12: false });
  return sameDay
    ? clock
    : `${date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })} ${clock}`;
};

/** Plan windows report a Unix epoch in seconds. */
export const formatReset = (
  epochSeconds: number | undefined,
  t: (
    key: 'plan.resetting' | 'plan.resetsInMinutes' | 'plan.resetsInHours' | 'plan.resetsOn',
    vars?: Record<string, string | number>,
  ) => string,
): string => {
  if (epochSeconds === undefined) return '';
  const date = new Date(epochSeconds * 1000);
  const minutes = Math.round((date.getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return t('plan.resetting');
  if (minutes < 60) return t('plan.resetsInMinutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? t('plan.resetsInHours', { n: hours })
    : t('plan.resetsOn', { date: date.toLocaleDateString() });
};

/** How long a card has been stuck, for the "waiting since" line. */
export const formatWaitingFor = (sinceIso: string): string => formatDuration(sinceIso);

/** "22:00" today, "24/09 05:00" on another day: a reset time, as people say it. */
export const formatResetClock = (epochSeconds: number): string => {
  const at = new Date(epochSeconds * 1000);
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === new Date().toDateString()
    ? time
    : `${at.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })} ${time}`;
};

/** Minute granularity: "<1m", "12m", "1h 5m", "2d". Seconds would tick, and ticking is motion. */
export const formatSpan = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
};
