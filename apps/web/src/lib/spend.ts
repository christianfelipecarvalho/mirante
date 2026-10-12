import { totalTokens, type SessionLane } from '@mirante/shared';

const latest = (values: (string | undefined)[]) =>
  values
    .filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))))
    .sort()
    .at(-1);

/** Only reported money is summed; absent readings never mean a zero charge. */
export const summarizeSpend = (sessions: readonly SessionLane[]) => {
  const reported = sessions.filter((lane) => lane.costUsd !== undefined);
  return {
    tokens: sessions.reduce((sum, lane) => sum + totalTokens(lane.tokens), 0),
    costUsd: reported.length ? reported.reduce((sum, lane) => sum + lane.costUsd!, 0) : undefined,
    reportedSessions: reported.length,
    totalSessions: sessions.length,
    usageUpdatedAt: latest(sessions.map((lane) => lane.usageUpdatedAt)),
    costUpdatedAt: latest(reported.map((lane) => lane.costUpdatedAt)),
  };
};

/** Exact integers keep small arrivals visible even on a large historical total. */
export const formatLiveTokens = (value: number, locale: string) =>
  value.toLocaleString(locale, { maximumFractionDigits: 0 });

/** Native USD readings, with enough precision to show sub-cent changes. */
export const formatLiveCost = (usd: number, locale: string) =>
  usd.toLocaleString(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  });
