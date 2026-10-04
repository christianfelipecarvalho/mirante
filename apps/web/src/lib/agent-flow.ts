import type { AgentCard, SessionLane } from '@mirante/shared';
import { isWaitingState, livenessOf } from '@mirante/shared';

export const FLOW_NODE_WIDTH = 240;
export const FLOW_NODE_HEIGHT = 180;
export const FLOW_COLUMN_GAP = 86;
export const FLOW_ROW_GAP = 30;
export const FLOW_PADDING = 20;

export type AgentFlowNode = {
  card: AgentCard;
  depth: number;
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

const TRANSITION_WINDOW_MS = 5_000;

/**
 * Turns the parent links already projected by Mirante into a stable tree.
 *
 * The layout is deliberately deterministic: a WebSocket update changes state
 * without making every node jump to a new place. Children keep spawn order,
 * leaves take rows, and parents sit halfway between their first and last child.
 * Missing links remain a forest: an unknown parent must not become a made-up
 * connection to the main agent.
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

  let nextLeaf = 0;
  let maxDepth = 0;
  const placed: AgentFlowNode[] = [];

  const place = (card: AgentCard, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth);
    // Preorder keeps keyboard navigation in the same parent-first order as
    // the diagram. Coordinates are filled after placing the children.
    const node: AgentFlowNode = {
      card,
      depth,
      x: FLOW_PADDING + depth * (FLOW_NODE_WIDTH + FLOW_COLUMN_GAP),
      y: 0,
    };
    placed.push(node);
    const ownChildren = children.get(card.agentId) ?? [];
    const childRows = ownChildren.map((child) => place(child, depth + 1));
    const row = childRows.length === 0 ? nextLeaf++ : (childRows[0]! + childRows.at(-1)!) / 2;
    node.y = FLOW_PADDING + row * (FLOW_NODE_HEIGHT + FLOW_ROW_GAP);
    return row;
  };

  for (const root of roots) place(root, 0);

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

  const rows = Math.max(nextLeaf, 1);
  return {
    nodes: placed,
    edges,
    width: FLOW_PADDING * 2 + (maxDepth + 1) * FLOW_NODE_WIDTH + maxDepth * FLOW_COLUMN_GAP,
    height: FLOW_PADDING * 2 + rows * FLOW_NODE_HEIGHT + (rows - 1) * FLOW_ROW_GAP,
  };
};
