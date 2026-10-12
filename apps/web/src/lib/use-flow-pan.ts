import { useEffect, type RefObject } from 'react';

/** Native scrolling for touch; pointer dragging for the canvas background,
 * or any part of the map while Space is held. Cards keep their normal click. */
export const useFlowPan = (shell: RefObject<HTMLDivElement | null>) => {
  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    let hovered = false;
    let space = false;
    let suppressClick = false;
    let drag:
      | { pointerId: number; x: number; y: number; left: number; top: number; moved: boolean }
      | undefined;
    const ready = () => {
      element.dataset.panReady = String(space);
    };
    const stop = () => {
      const previous = drag;
      drag = undefined;
      element.dataset.panning = 'false';
      if (previous && element.hasPointerCapture(previous.pointerId))
        element.releasePointerCapture(previous.pointerId);
    };
    const enter = () => {
      hovered = true;
    };
    const leave = () => {
      hovered = false;
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === 'touch' || drag) return;
      suppressClick = false;
      const target = event.target as Element;
      if (!space && target.closest('button, a, input, textarea, select, [contenteditable="true"]'))
        return;
      suppressClick = space;
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: element.scrollLeft,
        top: element.scrollTop,
        moved: false,
      };
      element.focus({ preventScroll: true });
      element.dataset.panning = 'true';
      element.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) {
        drag.moved = true;
        suppressClick = true;
      }
      element.scrollLeft = drag.left - dx;
      element.scrollTop = drag.top - dy;
      event.preventDefault();
    };
    const up = (event: PointerEvent) => {
      if (event.type === 'pointercancel') suppressClick = false;
      if (drag?.pointerId === event.pointerId) stop();
    };
    const lost = () => {
      if (drag) {
        suppressClick = false;
        stop();
      }
    };
    const click = (event: MouseEvent) => {
      if (event.detail === 0) {
        suppressClick = false;
        return;
      }
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (!hovered && !element.contains(document.activeElement)) return;
      if (
        (event.target as Element)?.closest?.(
          'button, a, input, textarea, select, [contenteditable="true"]',
        )
      )
        return;
      space = true;
      ready();
      event.preventDefault();
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !space) return;
      space = false;
      ready();
      event.preventDefault();
    };
    const blur = () => {
      space = false;
      ready();
      suppressClick = false;
      stop();
    };
    element.addEventListener('pointerenter', enter);
    element.addEventListener('pointerleave', leave);
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.addEventListener('lostpointercapture', lost);
    element.addEventListener('click', click, true);
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    return () => {
      stop();
      element.removeEventListener('pointerenter', enter);
      element.removeEventListener('pointerleave', leave);
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      element.removeEventListener('lostpointercapture', lost);
      element.removeEventListener('click', click, true);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
      delete element.dataset.panReady;
      delete element.dataset.panning;
    };
  }, [shell]);
};
