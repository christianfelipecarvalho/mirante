import { describe, expect, it, vi } from 'vitest';
import type { MiranteEvent } from '@mirante/shared';
import { collectEventPages, type EventPage } from './event-pages.js';

const event = (id: number) => ({ id }) as MiranteEvent;

describe('loading a complete event history', () => {
  it('follows every cursor before handing history to the projector', async () => {
    const next = vi.fn(async (since: number): Promise<EventPage> =>
      since === 2 ? { events: [event(3)], hasMore: true } : { events: [event(4)], hasMore: false },
    );
    const events = await collectEventPages({ events: [event(1), event(2)], hasMore: true }, next);
    expect(events.map((item) => item.id)).toEqual([1, 2, 3, 4]);
    expect(next.mock.calls).toEqual([[2], [3]]);
  });

  it('accepts a complete response from an older daemon without pagination metadata', async () => {
    const next = vi.fn();
    expect(await collectEventPages({ events: [event(1)] }, next)).toEqual([event(1)]);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects stalled recovery instead of silently skipping events or looping forever', async () => {
    await expect(collectEventPages({ events: [], hasMore: true }, vi.fn())).rejects.toThrow(
      'no cursor',
    );
    for (const events of [[], [event(1)]]) {
      await expect(
        collectEventPages({ events: [event(1)], hasMore: true }, async () => ({
          events,
          hasMore: true,
        })),
      ).rejects.toThrow('did not advance');
    }
  });
});
