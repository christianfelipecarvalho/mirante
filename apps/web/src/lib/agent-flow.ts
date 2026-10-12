import type { AgentCard, SessionLane } from '@mirante/shared';
import { isWaitingState, livenessOf } from '@mirante/shared';

export const FLOW_NODE_WIDTH = 240;
export const FLOW_NODE_HEIGHT = 180;
export const FLOW_NODE_GAP = 32;
export const FLOW_PADDING = 20;

export type AgentFlowNode = {
  card: AgentCard;
  depth: number;
  /** Visual orbit; a crowded generation may occupy more than one ring. */
  orbit: number;
  x: number;
  y: number;
};

export type AgentFlowEdgeState =
  'delegating' | 'active' | 'waiting' | 'returning' | 'closed' | 'idle' | 'silent';

export type AgentFlowEdge = {
  id: string;
  parentId: string;
  childId: string;
  state: AgentFlowEdgeState;
  /** Direction of the information currently travelling through the edge. */
  direction: 'outbound' | 'inbound' | 'none';
};

export type AgentFlow = {
  nodes: AgentFlowNode[];
  edges: AgentFlowEdge[];
  width: number;
  height: number;
};

/** A follow-up changes startedAt and can reorder a projector snapshot. Remember
 * the order first observed in this view, appending only genuinely new IDs, so
 * resuming an existing agent changes neither its orbit nor its identity colour. */
export const stableAgentCards = (cards: readonly AgentCard[], remembered: readonly string[]) => {
  const known = new Set(remembered);
  const order = [
    ...remembered,
    ...cards.filter((card) => !known.has(card.agentId)).map((card) => card.agentId),
  ];
  const byId = new Map(cards.map((card) => [card.agentId, card]));
  return {
    order,
    cards: order.flatMap((id) => {
      const card = byId.get(id);
      return card ? [card] : [];
    }),
  };
};

const TRANSITION_WINDOW_MS = 5_000;

/**
 * The observed main agent anchors a deterministic set of orbits. Parent links
 * remain the authority on relationships; rings are visual space, not invented
 * genealogy. Crowded generations spill outward, keeping a readable inner ring.
 * State updates do not influence order, radii, or the symmetric canvas bounds.
 */
export const buildAgentFlow = (lane: SessionLane, now: number): AgentFlow => {
  const cards = lane.cards;
  if (cards.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const byId = new Map(cards.map((card) => [card.agentId, card]));
  const parentById = new Map<string, string>();
  const children = new Map<string, AgentCard[]>();
  const roots: AgentCard[] = [];

  for (const card of cards) {
    const parentId = card.parentAgentId;
    if (!parentId || !byId.has(parentId) || card.agentId === 'main') continue;
    // Reject only the link that would complete a cycle. Layout and edges then
    // share exactly the same forest, and every observed card remains visible.
    const ancestors = new Set([card.agentId]);
    let ancestor: string | undefined = parentId;
    while (ancestor && !ancestors.has(ancestor)) {
      ancestors.add(ancestor);
      ancestor = parentById.get(ancestor);
    }
    if (!ancestor) parentById.set(card.agentId, parentId);
  }

  for (const card of cards) {
    const parentId = parentById.get(card.agentId);
    if (!parentId) roots.push(card);
    else children.set(parentId, [...(children.get(parentId) ?? []), card]);
  }

  // Prefer the session root even when an older capture omitted a parent link.
  roots.sort((a, b) => Number(b.agentId === 'main') - Number(a.agentId === 'main'));

  const anchor = byId.get('main') ?? roots[0]!;
  const placed: AgentFlowNode[] = [];
  const pending = roots.toReversed().map((card) => ({ card, depth: 0 }));
  // Parent-first DOM order stays independent of the spatial ring allocation.
  while (pending.length > 0) {
    const { card, depth } = pending.pop()!;
    placed.push({ card, depth, orbit: 0, x: 0, y: 0 });
    for (const child of (children.get(card.agentId) ?? []).toReversed()) {
      pending.push({ card: child, depth: depth + 1 });
    }
  }
  const nodes = new Map(placed.map((node) => [node.card.agentId, node]));
  const rings = new Map<number, AgentFlowNode[]>();
  const queue = [
    ...(children.get(anchor.agentId) ?? []),
    ...roots.filter((root) => root.agentId !== anchor.agentId),
  ];
  for (let index = 0; index < queue.length; index += 1) {
    const card = queue[index]!;
    const node = nodes.get(card.agentId)!;
    const parent = nodes.get(parentById.get(card.agentId) ?? '');
    let orbit = (parent?.orbit ?? 0) + 1;
    // Eight neighbours around the center; each outer orbit has more capacity.
    // A child always sits farther out than its actual parent.
    while ((rings.get(orbit)?.length ?? 0) >= orbit * 8) orbit += 1;
    node.orbit = orbit;
    rings.set(orbit, [...(rings.get(orbit) ?? []), node]);
    queue.push(...(children.get(card.agentId) ?? []));
  }

  const rank = new Map(placed.map((node, index) => [node.card.agentId, index]));
  const stepX = FLOW_NODE_WIDTH + FLOW_NODE_GAP;
  const stepY = FLOW_NODE_HEIGHT + FLOW_NODE_GAP;
  let previousRadius = 0;
  let extentX = 0;
  let extentY = 0;
  // In normalized coordinates each card occupies a unit rectangle. A radial
  // gap of sqrt(2) separates every pair across adjacent rings. Within a ring,
  // solve rectangle separation directly instead of over-spacing by diagonals.
  const separation = (dx: number, dy: number) => 1 / Math.max(Math.abs(dx), Math.abs(dy));
  for (const [, ring] of [...rings.entries()].sort(([a], [b]) => a - b)) {
    ring.sort((a, b) => rank.get(a.card.agentId)! - rank.get(b.card.agentId)!);
    const angular = ring
      .map((node, index) => {
        const parent = nodes.get(parentById.get(node.card.agentId) ?? '');
        const preferred =
          parent && parent.orbit > 0
            ? (Math.atan2(parent.y / stepY, parent.x / stepX) + Math.PI * 2) % (Math.PI * 2)
            : (index / ring.length) * Math.PI * 2;
        return { node, preferred };
      })
      .sort((a, b) => a.preferred - b.preferred);
    const rotation =
      angular.reduce(
        (sum, entry, index) => sum + entry.preferred - (index / ring.length) * Math.PI * 2,
        0,
      ) / ring.length;
    // Blend a parent's direction with evenly spaced slots. This groups its
    // descendants while leaving a guaranteed nonzero angle between neighbours;
    // a single descendant stays exactly on its parent's outward ray.
    const points = angular.map(({ preferred }, index) => {
      const angle = preferred * 0.55 + (rotation + (index / ring.length) * Math.PI * 2) * 0.45;
      return { x: Math.cos(angle), y: Math.sin(angle) };
    });
    ring.splice(0, ring.length, ...angular.map(({ node }) => node));
    let radius = previousRadius === 0 ? 1 : previousRadius + Math.SQRT2;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      radius = Math.max(radius, separation(point.x, point.y));
      for (const other of points.slice(index + 1)) {
        radius = Math.max(radius, separation(point.x - other.x, point.y - other.y));
      }
    }
    radius += 0.001; // Keep the intended gutter despite floating-point rounding.
    previousRadius = radius;
    for (let index = 0; index < ring.length; index += 1) {
      const node = ring[index]!;
      node.x = points[index]!.x * radius * stepX;
      node.y = points[index]!.y * radius * stepY;
      extentX = Math.max(extentX, Math.abs(node.x));
      extentY = Math.max(extentY, Math.abs(node.y));
    }
  }
  // Equal extents on both sides keep the main at the canvas center, including
  // asymmetric subtrees and captures with unrelated roots.
  const width = Math.ceil((extentX + FLOW_NODE_WIDTH / 2 + FLOW_PADDING) * 2);
  const height = Math.ceil((extentY + FLOW_NODE_HEIGHT / 2 + FLOW_PADDING) * 2);
  for (const node of placed) {
    node.x += width / 2 - FLOW_NODE_WIDTH / 2;
    node.y += height / 2 - FLOW_NODE_HEIGHT / 2;
  }

  const edgeState = (
    parent: AgentCard,
    child: AgentCard,
  ): Pick<AgentFlowEdge, 'state' | 'direction'> => {
    const started = Date.parse(child.startedAt);
    const ended = child.endedAt ? Date.parse(child.endedAt) : undefined;
    if (ended !== undefined && now >= ended && now - ended <= TRANSITION_WINDOW_MS) {
      return { state: 'returning', direction: 'inbound' };
    }
    if (child.endedAt) return { state: 'closed', direction: 'none' };
    const liveness = livenessOf(child, now, Boolean(lane.endedAt));
    if (liveness === 'silent') return { state: 'silent', direction: 'none' };
    if (lane.endedAt || child.status.state === 'done' || child.status.state === 'error') {
      return { state: 'closed', direction: 'none' };
    }
    if (
      isWaitingState(child.status.state) ||
      (parent.status.state === 'waiting_subagent' && parent.status.waitingOn?.ref === child.agentId)
    ) {
      return { state: 'waiting', direction: 'none' };
    }
    if (liveness !== 'live') return { state: 'idle', direction: 'none' };
    if (now >= started && now - started <= TRANSITION_WINDOW_MS) {
      return { state: 'delegating', direction: 'outbound' };
    }
    return { state: 'active', direction: 'outbound' };
  };

  const edges = cards.flatMap((child): AgentFlowEdge[] => {
    const parentId = parentById.get(child.agentId);
    if (!parentId) return [];
    const parent = byId.get(parentId);
    if (!parent) return [];
    return [
      {
        id: `${parent.agentId}:${child.agentId}`,
        parentId: parent.agentId,
        childId: child.agentId,
        ...edgeState(parent, child),
      },
    ];
  });

  return { nodes: placed, edges, width, height };
};

/** Show recent work, its principal, and its actual ancestor path.
 * Filtering the completed layout preserves every retained coordinate and the
 * viewport's scroll position as agents stop and resume. Nothing is deleted. */
export const filterInactiveAgents = (
  flow: AgentFlow,
  now: number,
  sessionEnded = false,
): AgentFlow => {
  const parentById = new Map(flow.edges.map((edge) => [edge.childId, edge.parentId]));
  const retained = new Set<string>();
  const anchor = flow.nodes.find((node) => node.card.agentId === 'main') ?? flow.nodes[0];
  if (anchor) retained.add(anchor.card.agentId);
  for (const { card } of flow.nodes) {
    const live = !card.endedAt && livenessOf(card, now, sessionEnded) === 'live';
    if (!live) continue;
    let id: string | undefined = card.agentId;
    while (id && !retained.has(id)) {
      retained.add(id);
      id = parentById.get(id);
    }
  }
  return {
    ...flow,
    nodes: flow.nodes.filter((node) => retained.has(node.card.agentId)),
    edges: flow.edges.filter((edge) => retained.has(edge.parentId) && retained.has(edge.childId)),
  };
};

type FlowPoint = { x: number; y: number };
export type AgentFlowPath = {
  path: string;
  from: FlowPoint;
  to: FlowPoint;
  midpoint: FlowPoint;
  points: FlowPoint[];
};

const centerOf = (node: AgentFlowNode): FlowPoint => ({
  x: node.x + FLOW_NODE_WIDTH / 2,
  y: node.y + FLOW_NODE_HEIGHT / 2,
});
const distance = (a: FlowPoint, b: FlowPoint) => Math.hypot(b.x - a.x, b.y - a.y);
const borderToward = (node: AgentFlowNode, point: FlowPoint): FlowPoint => {
  const center = centerOf(node);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  if (Math.abs(dx) + Math.abs(dy) < 1e-8) return { x: center.x + FLOW_NODE_WIDTH / 2, y: center.y };
  const fraction =
    1 / Math.max(Math.abs(dx) / (FLOW_NODE_WIDTH / 2), Math.abs(dy) / (FLOW_NODE_HEIGHT / 2));
  return { x: center.x + dx * fraction, y: center.y + dy * fraction };
};
const pathThrough = (points: FlowPoint[]): AgentFlowPath => {
  const lengths = points.slice(1).map((point, index) => distance(points[index]!, point));
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
  let midpoint = points[0]!;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (remaining <= length) {
      const a = points[index]!;
      const b = points[index + 1]!;
      const fraction = length === 0 ? 0 : remaining / length;
      midpoint = { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
      break;
    }
    remaining -= length;
  }
  return {
    path: points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
      .join(' '),
    from: points[0]!,
    to: points.at(-1)!,
    midpoint,
    points,
  };
};

/** Intersect the center-to-center ray with each card rectangle. */
export const agentFlowPath = (from: AgentFlowNode, to: AgentFlowNode): AgentFlowPath => {
  // Free placement permits coincident cards. Keep a finite, visible relationship
  // around their perimeter instead of multiplying zero by an infinite fraction.
  if (distance(centerOf(from), centerOf(to)) < 1e-8) {
    const left = from.x - 12;
    const right = from.x + FLOW_NODE_WIDTH + 12;
    const top = from.y - 12;
    const middle = from.y + FLOW_NODE_HEIGHT / 2;
    return pathThrough([
      { x: from.x + FLOW_NODE_WIDTH, y: middle },
      { x: right, y: middle },
      { x: right, y: top },
      { x: left, y: top },
      { x: left, y: middle },
      { x: from.x, y: middle },
    ]);
  }
  return pathThrough([borderToward(from, centerOf(to)), borderToward(to, centerOf(from))]);
};

/** Handbacks travel over the same corridor in the opposite direction. */
export const reverseAgentFlowPath = (path: AgentFlowPath): AgentFlowPath => ({
  ...pathThrough(path.points.toReversed()),
  midpoint: path.midpoint,
});

type FlowObstacle = { id: string; left: number; right: number; top: number; bottom: number };

// Liang–Barsky clipping against the open rectangle interior. Walking along an
// expanded obstacle's boundary is safe; walking through it is not.
const crossesObstacle = (a: FlowPoint, b: FlowPoint, box: FlowObstacle) => {
  let low = 0;
  let high = 1;
  for (const [start, delta, min, max] of [
    [a.x, b.x - a.x, box.left + 1e-7, box.right - 1e-7],
    [a.y, b.y - a.y, box.top + 1e-7, box.bottom - 1e-7],
  ] as const) {
    if (Math.abs(delta) < 1e-10) {
      if (start < min || start > max) return false;
      continue;
    }
    const first = (min - start) / delta;
    const last = (max - start) / delta;
    low = Math.max(low, Math.min(first, last));
    high = Math.min(high, Math.max(first, last));
    if (low >= high) return false;
  }
  return high > 0 && low < 1;
};

/** Keep real relationships readable in crowded orbits. Clear connections stay
 * straight; blocked connections use the shortest visible corridor around card
 * corners, with 12px clearance. The caller supplies visible obstacles and caches
 * by geometry: hidden cards must not force detours through empty space. */
export const routeAgentFlow = (flow: AgentFlow): Map<string, AgentFlowPath> => {
  const clearance = 12;
  const obstacles = flow.nodes.map((node): FlowObstacle => ({
    id: node.card.agentId,
    left: node.x - clearance,
    right: node.x + FLOW_NODE_WIDTH + clearance,
    top: node.y - clearance,
    bottom: node.y + FLOW_NODE_HEIGHT + clearance,
  }));
  const nodes = new Map(flow.nodes.map((node) => [node.card.agentId, node]));
  const clear = (a: FlowPoint, b: FlowPoint, except?: string, alsoExcept?: string) =>
    !obstacles.some(
      (box) => box.id !== except && box.id !== alsoExcept && crossesObstacle(a, b, box),
    );
  const corners = obstacles.flatMap((box) => [
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.right, y: box.bottom },
    { x: box.left, y: box.bottom },
  ]);
  type Link = { index: number; length: number };
  let visibility: Link[][] | undefined;
  const paths = new Map<string, AgentFlowPath>();
  for (const edge of flow.edges) {
    const from = nodes.get(edge.parentId)!;
    const to = nodes.get(edge.childId)!;
    const start = centerOf(from);
    const end = centerOf(to);
    if (clear(start, end, edge.parentId, edge.childId)) {
      paths.set(edge.id, agentFlowPath(from, to));
      continue;
    }
    // The corner graph is shared across all blocked edges in this topology.
    if (!visibility) {
      visibility = corners.map(() => []);
      for (let a = 0; a < corners.length; a += 1) {
        for (let b = a + 1; b < corners.length; b += 1) {
          if (!clear(corners[a]!, corners[b]!)) continue;
          const length = distance(corners[a]!, corners[b]!);
          visibility[a]!.push({ index: b, length });
          visibility[b]!.push({ index: a, length });
        }
      }
    }
    const distances = corners.map((point) =>
      clear(start, point, edge.parentId) ? distance(start, point) : Infinity,
    );
    const goalDistances = corners.map((point) =>
      clear(point, end, edge.childId) ? distance(point, end) : Infinity,
    );
    const previous = corners.map(() => -1);
    const visited = new Set<number>();
    let goal = -1;
    let best = Infinity;
    // Dijkstra finds the short detour without moving cards or widening rings.
    for (let iteration = 0; iteration < corners.length; iteration += 1) {
      let current = -1;
      for (let index = 0; index < corners.length; index += 1) {
        if (!visited.has(index) && (current === -1 || distances[index]! < distances[current]!))
          current = index;
      }
      if (current === -1 || distances[current]! >= best) break;
      visited.add(current);
      const total = distances[current]! + goalDistances[current]!;
      if (total < best) {
        best = total;
        goal = current;
      }
      for (const link of visibility[current]!) {
        const length = distances[current]! + link.length;
        if (length < distances[link.index]!) {
          distances[link.index] = length;
          previous[link.index] = current;
        }
      }
    }
    // Non-overlapping rectangles always leave a route around their perimeter.
    // Fall back safely if a future external layout supplies invalid geometry.
    if (goal === -1) {
      paths.set(edge.id, agentFlowPath(from, to));
      continue;
    }
    const bends: FlowPoint[] = [];
    for (let index = goal; index !== -1; index = previous[index]!) bends.unshift(corners[index]!);
    paths.set(
      edge.id,
      pathThrough([borderToward(from, bends[0]!), ...bends, borderToward(to, bends.at(-1)!)]),
    );
  }
  return paths;
};
