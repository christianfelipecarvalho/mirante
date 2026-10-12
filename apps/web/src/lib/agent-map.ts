import { livenessOf, type AgentCard } from '@mirante/shared';

export type AgentMapNode = {
  card: AgentCard;
  depth: number;
  /** An observed parent that is present in this map and does not form a cycle. */
  parentId?: string;
  childIds: string[];
};

export type AgentMap = {
  /** Parent-first depth-first order; siblings retain their received order. */
  nodes: AgentMapNode[];
  roots: string[];
};

/**
 * Build a compact forest from only the cards supplied by the view. Missing
 * parents become separate roots, rather than implying a relationship to main.
 * The first occurrence of an ID wins. Main is the preferred root; malformed
 * cycles lose only the last participant's parent link in received order.
 * Iterative traversal keeps even deeply nested captures linear and stack-safe.
 */
export const buildAgentMap = (cards: readonly AgentCard[]): AgentMap => {
  const byId = new Map<string, AgentCard>();
  const rank = new Map<string, number>();
  for (const card of cards) {
    if (byId.has(card.agentId)) continue;
    rank.set(card.agentId, byId.size);
    byId.set(card.agentId, card);
  }

  const parents = new Map<string, string>();
  for (const card of byId.values()) {
    const parentId = card.parentAgentId;
    if (
      parentId !== undefined &&
      byId.has(parentId) &&
      card.agentId !== 'main' &&
      parentId !== card.agentId
    ) {
      parents.set(card.agentId, parentId);
    }
  }

  // Each node has at most one parent. A path therefore visits each node once,
  // and a repeated node identifies the exact cycle without ancestor rescans.
  const visited = new Set<string>();
  for (const agentId of byId.keys()) {
    if (visited.has(agentId)) continue;
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let cursor: string | undefined = agentId;
    while (cursor !== undefined && !visited.has(cursor)) {
      const repeatedAt = onPath.get(cursor);
      if (repeatedAt !== undefined) {
        let last = cursor;
        for (let index = repeatedAt; index < path.length; index += 1) {
          const member = path[index]!;
          if (rank.get(member)! > rank.get(last)!) last = member;
        }
        parents.delete(last);
        break;
      }
      onPath.set(cursor, path.length);
      path.push(cursor);
      cursor = parents.get(cursor);
    }
    for (const member of path) visited.add(member);
  }

  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const agentId of byId.keys()) {
    const parentId = parents.get(agentId);
    if (parentId === undefined) {
      if (agentId === 'main') roots.unshift(agentId);
      else roots.push(agentId);
    } else {
      const siblings = children.get(parentId);
      if (siblings) siblings.push(agentId);
      else children.set(parentId, [agentId]);
    }
  }

  const nodes: AgentMapNode[] = [];
  const pending = roots.toReversed().map((agentId) => ({ agentId, depth: 0 }));
  while (pending.length > 0) {
    const { agentId, depth } = pending.pop()!;
    const parentId = parents.get(agentId);
    const childIds = children.get(agentId) ?? [];
    nodes.push({
      card: byId.get(agentId)!,
      depth,
      ...(parentId !== undefined ? { parentId } : {}),
      childIds,
    });
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      pending.push({ agentId: childIds[index]!, depth: depth + 1 });
    }
  }
  return { nodes, roots };
};

/**
 * Match the canvas's working-only filter without computing canvas geometry.
 * Keep the principal as a reference, recent work, and its observed ancestor
 * paths. Waiting and finished ancestors remain references to visible work,
 * rather than acquiring an active state. The original forest is unchanged.
 */
export const filterAgentMap = (map: AgentMap, now: number, sessionEnded = false): AgentMap => {
  const parents = new Map(map.nodes.map((node) => [node.card.agentId, node.parentId]));
  const retained = new Set<string>();
  const anchor = map.nodes.find((node) => node.card.agentId === 'main') ?? map.nodes[0];
  if (anchor) retained.add(anchor.card.agentId);
  for (const { card } of map.nodes) {
    if (card.endedAt || livenessOf(card, now, sessionEnded) !== 'live') continue;
    let agentId: string | undefined = card.agentId;
    while (agentId !== undefined && !retained.has(agentId)) {
      retained.add(agentId);
      agentId = parents.get(agentId);
    }
  }
  return {
    nodes: map.nodes
      .filter((node) => retained.has(node.card.agentId))
      .map((node) => ({
        ...node,
        childIds: node.childIds.filter((agentId) => retained.has(agentId)),
      })),
    roots: map.roots.filter((agentId) => retained.has(agentId)),
  };
};
