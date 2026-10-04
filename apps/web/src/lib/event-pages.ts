import type { MiranteEvent } from '@mirante/shared';

export type EventPage = { events: MiranteEvent[]; hasMore?: boolean };

/** Finish recovery before a later live event can skip the missing history. */
export const collectEventPages = async (
  first: EventPage,
  loadNext: (since: number) => Promise<EventPage>,
): Promise<MiranteEvent[]> => {
  const events = [...first.events];
  let page = first;
  while (page.hasMore) {
    const since = events.at(-1)?.id;
    if (since === undefined) throw new Error('An incomplete event page has no cursor');
    page = await loadNext(since);
    if (page.events.length === 0 || (page.events[0]?.id ?? 0) <= since)
      throw new Error('Event pagination did not advance');
    events.push(...page.events);
  }
  return events;
};
