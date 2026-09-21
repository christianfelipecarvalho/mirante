import { useEffect, useRef, useState } from 'react';

/**
 * Which items arrived since the last time the list changed.
 *
 * A live board's most useful signal is that something just happened, and the
 * cheapest way to say it is to mark the new rows for a moment. Ids are assumed
 * to increase, which the event log guarantees.
 *
 * The first render marks nothing: everything is new when you open the page, and
 * a screen that lights up all at once says nothing about what changed.
 */
export const useFreshIds = (ids: readonly number[], holdMs = 1600): ReadonlySet<number> => {
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const highest = useRef<number | undefined>(undefined);

  useEffect(() => {
    const max = ids.reduce((best, id) => (id > best ? id : best), 0);
    if (highest.current === undefined) {
      highest.current = max;
      return;
    }
    if (max <= highest.current) return;

    const previous = highest.current;
    highest.current = max;
    setFresh(new Set(ids.filter((id) => id > previous)));

    const timer = window.setTimeout(() => setFresh(new Set()), holdMs);
    return () => window.clearTimeout(timer);
  }, [ids, holdMs]);

  return fresh;
};
