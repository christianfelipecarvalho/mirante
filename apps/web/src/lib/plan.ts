import type { PlanWindow } from '@mirante/shared';

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
