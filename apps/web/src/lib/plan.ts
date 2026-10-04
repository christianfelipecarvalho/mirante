import { PLAN_READING_MAX_AGE_MS, type PlanWindow } from '@mirante/shared';
import type { Translate } from './i18n.js';

/**
 * What one plan window can honestly be said to show right now.
 *
 * `reset` is its own answer, distinct from `unknown`: the last reading exists,
 * but its window has rolled over since, so its percentage describes a period
 * that is over. Showing that number — last night's 100% at nine the next
 * morning — is the one wrong thing a meter can do.
 */
export type WindowReading =
  | { state: 'known'; percentage: number; resetsAt?: number }
  | { state: 'reset' }
  | { state: 'unknown' };

export const readWindow = (window: PlanWindow | undefined, now: number): WindowReading => {
  if (!window) return { state: 'unknown' };
  if (window.resetsAt !== undefined && window.resetsAt * 1000 <= now) return { state: 'reset' };
  return {
    state: 'known',
    percentage: window.usedPercentage,
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  };
};

/**
 * How old a plan reading is, in words, and whether it is old enough to doubt.
 *
 * Past an hour a figure is older than Claude Code itself trusts, and older
 * than any harness refreshes one while it works.
 */
export const readingAge = (
  readAt: number | undefined,
  now: number,
  t: Translate,
): { text: string; old: boolean } => {
  if (readAt === undefined || !Number.isFinite(readAt))
    return { text: t('plan.noReading'), old: false };
  const minutes = Math.max(0, Math.round((now - readAt) / 60_000));
  const text =
    minutes < 1
      ? t('plan.ago.justNow')
      : minutes <= 5
        ? t('plan.ago.minutes', { n: minutes })
        : t('plan.lastUsed', {
            d: minutes < 60 ? `${minutes}min` : `${Math.round(minutes / 60)}h`,
          });
  return { text, old: now - readAt > PLAN_READING_MAX_AGE_MS };
};
