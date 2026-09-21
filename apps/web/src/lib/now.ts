import { useEffect, useState } from 'react';

/**
 * A clock that ticks every half minute.
 *
 * Relative times — "3m ago", "resets in 2h" — are computed at render, and a
 * quiet board does not re-render. Without this, "just now" stays on screen for
 * an hour. Minute granularity is all these labels show, so ticking faster would
 * only be motion.
 */
export const useNow = (intervalMs = 30_000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
};
