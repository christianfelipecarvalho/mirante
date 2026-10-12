import {
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  type AgentFlowNode,
  type AgentFlowPath,
} from './agent-flow.js';

export type FlowPoint = { x: number; y: number };
export type FlowSize = { width: number; height: number };
export type FlowBounds = FlowSize & FlowPoint;
export const MIN_FLOW_ZOOM = 0.02;
export const MAX_FLOW_ZOOM = 2;
export const clampFlowZoom = (zoom: number) =>
  Number.isFinite(zoom) ? Math.max(MIN_FLOW_ZOOM, Math.min(MAX_FLOW_ZOOM, zoom)) : 1;

export const visibleFlowBounds = (
  nodes: readonly AgentFlowNode[],
  paths: readonly AgentFlowPath[] = [],
): FlowBounds => {
  if (!nodes.length) return { x: 0, y: 0, width: 0, height: 0 };
  const points = [
    ...nodes.flatMap((node) => [
      { x: node.x, y: node.y },
      { x: node.x + FLOW_NODE_WIDTH, y: node.y + FLOW_NODE_HEIGHT },
    ]),
    ...paths.flatMap((path) => path.points),
  ];
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  return {
    x: left,
    y: top,
    width: Math.max(...points.map((point) => point.x)) - left,
    height: Math.max(...points.map((point) => point.y)) - top,
  };
};

/** Physical stage bounds include centering space when the map is smaller than its viewport. */
export const flowStage = (content: FlowSize, viewport: FlowSize, zoom: number) => ({
  width: Math.max(viewport.width, content.width * zoom),
  height: Math.max(viewport.height, content.height * zoom),
  x: Math.max(0, (viewport.width - content.width * zoom) / 2),
  y: Math.max(0, (viewport.height - content.height * zoom) / 2),
});

export const scrollToFlowPoint = (
  content: FlowSize,
  viewport: FlowSize,
  zoom: number,
  world: FlowPoint,
  anchor: FlowPoint = { x: viewport.width / 2, y: viewport.height / 2 },
): FlowPoint => {
  const stage = flowStage(content, viewport, zoom);
  return {
    x: Math.max(0, Math.min(stage.width - viewport.width, stage.x + world.x * zoom - anchor.x)),
    y: Math.max(0, Math.min(stage.height - viewport.height, stage.y + world.y * zoom - anchor.y)),
  };
};

export const worldAtFlowPoint = (
  content: FlowSize,
  viewport: FlowSize,
  zoom: number,
  scroll: FlowPoint,
  anchor: FlowPoint,
): FlowPoint => {
  const stage = flowStage(content, viewport, zoom);
  return { x: (scroll.x + anchor.x - stage.x) / zoom, y: (scroll.y + anchor.y - stage.y) / zoom };
};

export const fitFlowViewport = (content: FlowSize, viewport: FlowSize, bounds: FlowBounds) => {
  const zoom = clampFlowZoom(
    Math.min(
      1,
      Math.max(1, viewport.width - 32) / Math.max(1, bounds.width),
      Math.max(1, viewport.height - 32) / Math.max(1, bounds.height),
    ),
  );
  return {
    zoom,
    scroll: scrollToFlowPoint(content, viewport, zoom, {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    }),
  };
};
