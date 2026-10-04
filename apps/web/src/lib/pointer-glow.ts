import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Where the light falls, in the card's own pixels.
 *
 * Clamped to the card: during a drag the pointer keeps reporting positions from
 * outside, and an unclamped glow slides off the edge and disappears while the
 * cursor is still on screen.
 */
export const glowPoint = (
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } => ({
  x: Math.min(Math.max(clientX - rect.left, 0), rect.width),
  y: Math.min(Math.max(clientY - rect.top, 0), rect.height),
});

const prefersStill = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A light that follows the pointer across a card.
 *
 * Written straight to the element as CSS variables rather than through state:
 * this fires on every pointer move, and a re-render per frame for a decoration
 * would be paid by every card on the board. One write per animation frame.
 *
 * Someone who asked their system to stop animating things keeps the card's
 * resting glow, centred, instead of one that chases the cursor.
 */
export const usePointerGlow = (): ((event: ReactPointerEvent<HTMLElement>) => void) => {
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (frame.current || prefersStill()) return;
    const card = event.currentTarget;
    const { x, y } = glowPoint(card.getBoundingClientRect(), event.clientX, event.clientY);
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      card.style.setProperty('--px', `${x}px`);
      card.style.setProperty('--py', `${y}px`);
    });
  }, []);
};
