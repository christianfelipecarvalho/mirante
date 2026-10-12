import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  clampFlowZoom,
  fitFlowViewport,
  flowStage,
  scrollToFlowPoint,
  worldAtFlowPoint,
  type FlowBounds,
  type FlowPoint,
  type FlowSize,
} from './flow-viewport';

/** Keep the scrollable footprint and the transformed HTML/SVG in agreement. */
export const useFlowViewport = (
  shell: RefObject<HTMLDivElement | null>,
  content: FlowSize,
  bounds: FlowBounds,
) => {
  const [viewport, setViewport] = useState<FlowSize>({ width: 0, height: 0 });
  const [view, setView] = useState({ zoom: 1, revision: 0 });
  const currentZoom = useRef(1);
  const pending = useRef<FlowPoint | undefined>(undefined);
  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [shell]);
  useLayoutEffect(() => {
    if (shell.current && pending.current) {
      shell.current.scrollLeft = pending.current.x;
      shell.current.scrollTop = pending.current.y;
      pending.current = undefined;
    }
  }, [shell, view]);

  const zoomTo = useCallback(
    (requested: number, anchor?: FlowPoint, world?: FlowPoint) => {
      const element = shell.current;
      if (!element) return;
      const size = { width: element.clientWidth, height: element.clientHeight };
      const point = anchor ?? { x: size.width / 2, y: size.height / 2 };
      const scroll = pending.current ?? { x: element.scrollLeft, y: element.scrollTop };
      const target = world ?? worldAtFlowPoint(content, size, currentZoom.current, scroll, point);
      const zoom = clampFlowZoom(requested);
      pending.current = scrollToFlowPoint(content, size, zoom, target, point);
      currentZoom.current = zoom;
      setView((previous) => ({ zoom, revision: previous.revision + 1 }));
    },
    [shell, content.width, content.height],
  );
  const zoomBy = useCallback((factor: number) => zoomTo(currentZoom.current * factor), [zoomTo]);
  const fit = useCallback(() => {
    const element = shell.current;
    if (!element) return;
    const result = fitFlowViewport(
      content,
      { width: element.clientWidth, height: element.clientHeight },
      bounds,
    );
    zoomTo(result.zoom, undefined, {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    });
  }, [shell, content.width, content.height, bounds, zoomTo]);

  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    const local = (x: number, y: number) => {
      const rect = element.getBoundingClientRect();
      return { x: x - rect.left - element.clientLeft, y: y - rect.top - element.clientTop };
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const pixels =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      zoomTo(currentZoom.current * Math.exp(-pixels * 0.002), local(event.clientX, event.clientY));
    };
    let pinch: { distance: number; zoom: number; world: FlowPoint } | undefined;
    const fingers = (event: TouchEvent) => {
      if (event.touches.length !== 2) return undefined;
      const a = event.touches[0]!;
      const b = event.touches[1]!;
      return {
        distance: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
        anchor: local((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2),
      };
    };
    const start = (event: TouchEvent) => {
      const pair = fingers(event);
      if (!pair || pair.distance < 1) return;
      event.preventDefault();
      pinch = {
        distance: pair.distance,
        zoom: currentZoom.current,
        world: worldAtFlowPoint(
          content,
          { width: element.clientWidth, height: element.clientHeight },
          currentZoom.current,
          { x: element.scrollLeft, y: element.scrollTop },
          pair.anchor,
        ),
      };
    };
    const move = (event: TouchEvent) => {
      const pair = fingers(event);
      if (!pair || !pinch) return;
      event.preventDefault();
      zoomTo((pinch.zoom * pair.distance) / pinch.distance, pair.anchor, pinch.world);
    };
    const end = () => {
      pinch = undefined;
    };
    element.addEventListener('wheel', wheel, { passive: false });
    element.addEventListener('touchstart', start, { passive: false });
    element.addEventListener('touchmove', move, { passive: false });
    element.addEventListener('touchend', end);
    element.addEventListener('touchcancel', end);
    return () => {
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('touchstart', start);
      element.removeEventListener('touchmove', move);
      element.removeEventListener('touchend', end);
      element.removeEventListener('touchcancel', end);
    };
  }, [shell, zoomTo, content.width, content.height]);

  return { zoom: view.zoom, zoomTo, zoomBy, fit, stage: flowStage(content, viewport, view.zoom) };
};
