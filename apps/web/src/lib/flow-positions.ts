import { FLOW_NODE_HEIGHT, FLOW_NODE_WIDTH, FLOW_PADDING, type AgentFlow } from './agent-flow.js';
import { clampFlowZoom, flowStage, type FlowPoint, type FlowSize } from './flow-viewport.js';

export type FlowPositions = Readonly<Record<string, FlowPoint>>;
export type StoredFlowPositions = { sessionId: string; positions: FlowPositions }[];
export const MAX_FLOW_POSITION = 100_000;
export const MAX_POSITION_SESSIONS = 40;
export const MAX_POSITION_AGENTS = 1_000;
export const EMPTY_FLOW_POSITIONS: FlowPositions = Object.freeze({});
const validId = (id: unknown): id is string =>
  typeof id === 'string' &&
  id.length > 0 &&
  id.length <= 512 &&
  !['__proto__', 'constructor', 'prototype'].includes(id);

/** Bound corrupt storage and extreme gestures without changing other cards. */
export const clampFlowPosition = (point: FlowPoint): FlowPoint => ({
  x: Number.isFinite(point.x)
    ? Math.min(MAX_FLOW_POSITION, Math.max(FLOW_PADDING, point.x))
    : FLOW_PADDING,
  y: Number.isFinite(point.y)
    ? Math.min(MAX_FLOW_POSITION, Math.max(FLOW_PADDING, point.y))
    : FLOW_PADDING,
});

export const parseFlowPositions = (raw: string | null): StoredFlowPositions => {
  if (!raw || raw.length > 4_000_000) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      value.version !== 1 ||
      !('sessions' in value) ||
      !Array.isArray(value.sessions)
    )
      return [];
    const sessions: StoredFlowPositions = [];
    const seen = new Set<string>();
    for (const entry of value.sessions.slice(-MAX_POSITION_SESSIONS)) {
      if (
        !entry ||
        !validId(entry.sessionId) ||
        seen.has(entry.sessionId) ||
        !entry.positions ||
        typeof entry.positions !== 'object' ||
        Array.isArray(entry.positions)
      )
        continue;
      const positions: Record<string, FlowPoint> = {};
      for (const [id, point] of Object.entries(entry.positions).slice(-MAX_POSITION_AGENTS)) {
        if (
          !validId(id) ||
          !point ||
          typeof point !== 'object' ||
          !('x' in point) ||
          !('y' in point) ||
          typeof point.x !== 'number' ||
          typeof point.y !== 'number' ||
          !Number.isFinite(point.x) ||
          !Number.isFinite(point.y)
        )
          continue;
        positions[id] = clampFlowPosition({ x: point.x, y: point.y });
      }
      seen.add(entry.sessionId);
      sessions.push({ sessionId: entry.sessionId, positions });
    }
    return sessions;
  } catch {
    return [];
  }
};

/** Recent sessions/agents win when the bounded local preference is full. */
export const updateFlowPositions = (
  stored: StoredFlowPositions,
  sessionId: string,
  agentId?: string,
  point?: FlowPoint,
): StoredFlowPositions => {
  if (!validId(sessionId) || (agentId !== undefined && !validId(agentId))) return stored;
  const previous =
    stored.find((entry) => entry.sessionId === sessionId)?.positions ?? EMPTY_FLOW_POSITIONS;
  const next = stored.filter((entry) => entry.sessionId !== sessionId);
  if (agentId && point) {
    const positions = Object.fromEntries(
      Object.entries(previous)
        .filter(([id]) => id !== agentId)
        .slice(-(MAX_POSITION_AGENTS - 1)),
    );
    positions[agentId] = clampFlowPosition(point);
    next.push({ sessionId, positions });
  }
  return next.slice(-MAX_POSITION_SESSIONS);
};

/** Saved world coordinates remain independent of filtering and viewport size. */
export const positionAgentFlow = (
  flow: AgentFlow,
  positions: FlowPositions,
  minimum?: FlowSize,
): AgentFlow => {
  const nodes = flow.nodes.map((node) => {
    const point = Object.hasOwn(positions, node.card.agentId)
      ? positions[node.card.agentId]
      : undefined;
    return point ? { ...node, ...clampFlowPosition(point) } : node;
  });
  return {
    ...flow,
    nodes,
    width: Math.max(
      flow.width,
      minimum?.width ?? 0,
      ...nodes.map((node) => node.x + FLOW_NODE_WIDTH + FLOW_PADDING),
    ),
    height: Math.max(
      flow.height,
      minimum?.height ?? 0,
      ...nodes.map((node) => node.y + FLOW_NODE_HEIGHT + FLOW_PADDING),
    ),
  };
};

export type FlowDragFrame = { content: FlowSize; viewport: FlowSize; currentViewport?: FlowSize };

/** Invert the rendered card position, including the changing centering inset
 * when a small map grows beyond its original footprint during the gesture. */
export const draggedFlowPosition = (
  origin: FlowPoint,
  delta: FlowPoint,
  requestedZoom: number,
  frame?: FlowDragFrame,
): FlowPoint => {
  const zoom = clampFlowZoom(requestedZoom);
  if (!frame)
    return clampFlowPosition({ x: origin.x + delta.x / zoom, y: origin.y + delta.y / zoom });
  const initial = flowStage(frame.content, frame.viewport, zoom);
  const viewport = frame.currentViewport ?? frame.viewport;
  const solve = (axis: 'x' | 'y', dimension: 'width' | 'height', nodeSize: number) => {
    const target = initial[axis] + origin[axis] * zoom + delta[axis];
    const rendered = (position: number) =>
      position * zoom +
      Math.max(
        0,
        (viewport[dimension] -
          Math.max(frame.content[dimension], position + nodeSize + FLOW_PADDING) * zoom) /
          2,
      );
    let low = FLOW_PADDING;
    let high = MAX_FLOW_POSITION;
    for (let step = 0; step < 36; step += 1) {
      const middle = (low + high) / 2;
      if (rendered(middle) < target) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  };
  return clampFlowPosition({
    x: solve('x', 'width', FLOW_NODE_WIDTH),
    y: solve('y', 'height', FLOW_NODE_HEIGHT),
  });
};

export const nudgedFlowPosition = (
  origin: FlowPoint,
  key: string,
  large = false,
): FlowPoint | undefined => {
  const amount = large ? 80 : 16;
  const deltas: Record<string, readonly number[]> = {
    ArrowLeft: [-amount, 0],
    ArrowRight: [amount, 0],
    ArrowUp: [0, -amount],
    ArrowDown: [0, amount],
  };
  const delta = Object.hasOwn(deltas, key) ? deltas[key] : undefined;
  return delta
    ? clampFlowPosition({ x: origin.x + delta[0]!, y: origin.y + delta[1]! })
    : undefined;
};
