import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { AgentFlowNode } from './agent-flow';
import { draggedFlowPosition, nudgedFlowPosition, type FlowDragFrame } from './flow-positions';
import type { FlowPoint } from './flow-viewport';

type DraftPosition = { sessionId: string; agentId: string; point: FlowPoint };
type Options = {
  sessionId: string;
  nodes: readonly AgentFlowNode[];
  zoom: () => number;
  content: { width: number; height: number };
  save: (id: string, point: FlowPoint) => void;
};

/** Node movement is independent of background/Space panning. A second finger
 * cancels the single-node gesture before the existing map pinch handler runs. */
export const useFlowNodeDrag = (shell: RefObject<HTMLDivElement | null>, options: Options) => {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const [draft, setDraft] = useState<DraftPosition | undefined>();
  const [announcement, setAnnouncement] = useState<{ agentId: string; point: FlowPoint }>();
  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    let gesture:
      | {
          id: number;
          agentId: string;
          button: HTMLButtonElement;
          start: FlowPoint;
          origin: FlowPoint;
          scroll: FlowPoint;
          point: FlowPoint;
          zoom: number;
          frame: FlowDragFrame;
          moved: boolean;
        }
      | undefined;
    let pending: FlowPoint | undefined;
    let frame = 0;
    let suppressClick = false;
    const touches = new Set<number>();
    const commit = (id: string, point: FlowPoint) => {
      latest.current.save(id, point);
      setAnnouncement({ agentId: id, point });
    };
    const stop = (save: boolean) => {
      const previous = gesture;
      gesture = undefined;
      cancelAnimationFrame(frame);
      frame = 0;
      if (previous) {
        delete previous.button.dataset.dragging;
        if (save && previous.moved) commit(previous.agentId, pending ?? previous.point);
        suppressClick = previous.moved;
        if (previous.button.hasPointerCapture(previous.id))
          previous.button.releasePointerCapture(previous.id);
      }
      delete element.dataset.nodeDragging;
      pending = undefined;
      setDraft(undefined);
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        touches.add(event.pointerId);
        if (touches.size > 1) {
          stop(false);
          return;
        }
      }
      if (event.button !== 0 || !event.isPrimary || gesture || element.dataset.panReady === 'true')
        return;
      const button = (event.target as Element).closest<HTMLButtonElement>('button.agent-flow-node');
      if (!button || !element.contains(button)) return;
      const node = latest.current.nodes.find(
        (candidate) => candidate.card.agentId === button.dataset.agentId,
      );
      if (!node) return;
      suppressClick = false;
      gesture = {
        id: event.pointerId,
        agentId: node.card.agentId,
        button,
        start: { x: event.clientX, y: event.clientY },
        origin: { x: node.x, y: node.y },
        scroll: { x: element.scrollLeft, y: element.scrollTop },
        point: { x: node.x, y: node.y },
        zoom: latest.current.zoom(),
        frame: {
          content: latest.current.content,
          viewport: { width: element.clientWidth, height: element.clientHeight },
        },
        moved: false,
      };
    };
    const move = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const delta = { x: event.clientX - gesture.start.x, y: event.clientY - gesture.start.y };
      if (!gesture.moved && Math.hypot(delta.x, delta.y) < 5) return;
      if (!gesture.moved) {
        gesture.moved = true;
        gesture.button.setPointerCapture(event.pointerId);
        gesture.button.focus({ preventScroll: true });
        gesture.button.dataset.dragging = 'true';
        element.dataset.nodeDragging = 'true';
      }
      event.preventDefault();
      pending = draggedFlowPosition(
        gesture.origin,
        {
          x: delta.x + element.scrollLeft - gesture.scroll.x,
          y: delta.y + element.scrollTop - gesture.scroll.y,
        },
        gesture.zoom,
        {
          ...gesture.frame,
          currentViewport: { width: element.clientWidth, height: element.clientHeight },
        },
      );
      gesture.point = pending;
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (gesture && pending)
            setDraft({
              sessionId: latest.current.sessionId,
              agentId: gesture.agentId,
              point: pending,
            });
        });
    };
    const up = (event: PointerEvent) => {
      touches.delete(event.pointerId);
      if (gesture?.id === event.pointerId) stop(event.type !== 'pointercancel');
    };
    const lost = (event: PointerEvent) => {
      // Touch starts with implicit capture on the hit span. Moving capture to
      // the card emits a bubbled loss for that span; it is not cancellation.
      if (
        gesture?.id === event.pointerId &&
        event.target === gesture.button &&
        !gesture.button.hasPointerCapture(event.pointerId)
      )
        stop(false);
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
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture) {
        event.preventDefault();
        stop(false);
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const button = (event.target as Element).closest<HTMLButtonElement>('button.agent-flow-node');
      const node = latest.current.nodes.find(
        (candidate) => candidate.card.agentId === button?.dataset.agentId,
      );
      if (!node) return;
      const point = nudgedFlowPosition(node, event.key, event.shiftKey);
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      commit(node.card.agentId, point);
    };
    const blur = () => {
      touches.clear();
      stop(false);
    };
    const wheel = () => {
      if (gesture) stop(false);
    };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    element.addEventListener('lostpointercapture', lost);
    element.addEventListener('click', click, true);
    element.addEventListener('keydown', key);
    element.addEventListener('wheel', wheel);
    window.addEventListener('blur', blur);
    return () => {
      stop(false);
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      element.removeEventListener('lostpointercapture', lost);
      element.removeEventListener('click', click, true);
      element.removeEventListener('keydown', key);
      element.removeEventListener('wheel', wheel);
      window.removeEventListener('blur', blur);
    };
  }, [shell, options.sessionId]);
  return { draft: draft?.sessionId === options.sessionId ? draft : undefined, announcement };
};
